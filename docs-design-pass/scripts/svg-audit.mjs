#!/usr/bin/env node
// Static legibility audit of a rendered chart SVG, in both themes: every text's size,
// every text's contrast against what is drawn behind it, and every non-text mark's
// contrast against the page. The dark theme is the SVG's own
// `@media (prefers-color-scheme: dark)` rules applied to the elements they select,
// so the audit checks what a GitHub dark-mode reader sees.
//
//   node svg-audit.mjs [--min-text 9] [--min-box-text 11] [--grid-color #e4e8ec] chart.svg...
//   import { auditSvg } from "./svg-audit.mjs"   (for a repo's own test)
//
// Exits 1 when any file has an issue, 2 on a usage or read error.
// Text needs 4.5:1, marks 3:1 (WCAG 2.x).
//
// What is read: presentation attributes, `style="..."` attributes, and the dark rules
// (`@media (prefers-color-scheme: dark){ tag[attr="value"]{prop:value} }`, any
// whitespace, any number of rules and blocks). fill, stroke, font-size and the opacities
// inherit through <g>/<text>/<tspan> ancestors; font-size takes px/pt/em/rem/% and
// keywords; <tspan> runs are audited on their own; translate() transforms offset the
// geometry. A stylesheet rule the audit cannot interpret (class or bare-tag selector,
// a rule outside the dark block, another @media) is reported as an issue, never dropped.
// Not modelled: rotate/scale/matrix transforms, <use>, gradients (reported as notes).
//
// auditSvg returns the issue strings; `.notes` on the returned array lists the
// assumptions made (for example the page colour used when the SVG draws no background).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GRID_COLOR = "#e4e8ec";
// the page behind an SVG that draws no background rect of its own
const FALLBACK_PAGE = { light: [255, 255, 255], dark: [13, 17, 23] };
const FALLBACK_NOTE =
  "no background rect: assuming a #ffffff page in light and #0d1117 in dark";

const lum = ([r, g, b]) => {
  const f = (c) => (
    (c /= 255),
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (a, b) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// colour string → { rgb, a } (null for none / unparsable)
export const parseColor = (s) => {
  s = typeof s === "string" ? s.trim() : s;
  if (!s || /^(none|transparent)$/i.test(s)) return null;
  if (/^black$/i.test(s)) return { rgb: [0, 0, 0], a: 1 };
  if (/^white$/i.test(s)) return { rgb: [255, 255, 255], a: 1 };
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m)
    return {
      rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)),
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  m = /^#([0-9a-f]{3})([0-9a-f])?$/i.exec(s);
  if (m)
    return {
      rgb: [...m[1]].map((c) => parseInt(c + c, 16)),
      a: m[2] ? parseInt(m[2] + m[2], 16) / 255 : 1,
    };
  m =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
      s,
    );
  if (m)
    return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  return null;
};
const over = (top, bottom) =>
  top.rgb.map((c, i) => c * top.a + bottom[i] * (1 - top.a));
const withAlpha = (c, k) => (c ? { ...c, a: c.a * k } : c);

// ---- SVG → small element tree --------------------------------------------------------

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decode = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, d, h, n) =>
    d
      ? String.fromCodePoint(+d)
      : h
        ? String.fromCodePoint(parseInt(h, 16))
        : (ENTITIES[n] ?? all),
  );

const parseAttrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    o[m[1]] = decode(m[2] ?? m[3]);
  return o;
};

// "fill:#fff; font-size:12px" → { fill, "font-size" }
const parseDecls = (body) => {
  const o = {};
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part
      .slice(i + 1)
      .replace(/!important\s*$/i, "")
      .trim();
    if (k && v) o[k] = v;
  }
  return o;
};

function parseSvg(src) {
  const root = { tag: "#root", a: {}, kids: [], parent: null };
  const styles = [];
  let cur = root;
  let last = 0;
  const addText = (to, from) => {
    const t = src.slice(from, to);
    if (t && cur !== root) cur.kids.push({ text: decode(t), parent: cur });
  };
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    addText(m.index, last);
    last = re.lastIndex;
    if (!m[2]) continue;
    const name = m[2];
    if (m[1]) {
      // closing tag: pop to the nearest open element of that name
      for (let p = cur; p && p !== root; p = p.parent)
        if (p.tag === name) {
          cur = p.parent;
          break;
        }
      continue;
    }
    const el = { tag: name, a: parseAttrs(m[3]), kids: [], parent: cur };
    if (el.a.style) el.style = parseDecls(el.a.style);
    cur.kids.push(el);
    if (m[4]) continue;
    if (name === "style") {
      // raw text up to </style>: CSS may hold `>` and quotes the tag pattern would misread
      const tail = /<\/style\s*>/i.exec(src.slice(last));
      const stop = tail ? last + tail.index : src.length;
      styles.push(src.slice(last, stop).replace(/<!\[CDATA\[|\]\]>/g, ""));
      last = re.lastIndex = tail ? stop + tail[0].length : src.length;
      continue;
    }
    cur = el;
  }
  addText(src.length, last);
  return { root, styles };
}

const walk = (el, fn) => {
  for (const k of el.kids || []) {
    if (k.text !== undefined) continue;
    fn(k);
    walk(k, fn);
  }
};

// ---- the stylesheet --------------------------------------------------------------------

// split on `sep` outside (), [] and quotes
const splitTop = (s, sep) => {
  const out = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
};

// `tag[attr="v"]`, `[attr='v']`, `rect[fill=#fff][stroke]` → { tag, conds } or null
const parseSelector = (sel) => {
  const m =
    /^(\*|[a-zA-Z][\w-]*)?((?:\[\s*[\w:-]+\s*(?:=\s*(?:"[^"]*"|'[^']*'|[^\]\s]+)\s*)?\])+)$/.exec(
      sel.trim(),
    );
  if (!m || (!m[1] && !m[2])) return null;
  const conds = [
    ...m[2].matchAll(
      /\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/g,
    ),
  ].map((c) => [c[1], c[2] ?? c[3] ?? c[4] ?? null]);
  return { tag: m[1] && m[1] !== "*" ? m[1] : null, conds };
};

// balanced {…} starting at the `{` at index i → index of its `}`
const closeBrace = (s, i) => {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return j;
  }
  return s.length;
};

// → { dark: [{ tag, conds, props }], problems: [string] }
function parseStylesheets(styles) {
  const dark = [];
  const problems = [];
  const rules = (css, where) => {
    let i = 0;
    while (i < css.length) {
      while (i < css.length && /\s/.test(css[i])) i++;
      if (i >= css.length) break;
      const brace = css.indexOf("{", i);
      const semi = css.indexOf(";", i);
      if (css[i] === "@" && semi >= 0 && (brace < 0 || semi < brace)) {
        problems.push(
          `unsupported at-rule "${css.slice(i, semi).trim()}": not applied`,
        );
        i = semi + 1;
        continue;
      }
      if (brace < 0) break;
      const end = closeBrace(css, brace);
      const prelude = css.slice(i, brace).trim().replace(/\s+/g, " ");
      const body = css.slice(brace + 1, end);
      i = end + 1;
      if (prelude.startsWith("@")) {
        const media = /^@media (.*)$/i.exec(prelude);
        if (
          media &&
          where === "top" &&
          /^\( ?prefers-color-scheme ?: ?dark ?\)$/i.test(media[1])
        )
          rules(body, "dark");
        else
          problems.push(`unsupported "${prelude}": its rules are not applied`);
        continue;
      }
      const props = parseDecls(body);
      for (const sel of splitTop(prelude, ",")) {
        const s = parseSelector(sel);
        if (where === "dark" && s) dark.push({ ...s, props });
        else
          problems.push(
            `unsupported selector "${sel.trim()}"${where === "dark" ? " in the dark rules" : " outside the dark @media block"}: its declarations are not applied`,
          );
      }
    }
  };
  for (const css of styles) rules(css.replace(/\/\*[\s\S]*?\*\//g, ""), "top");
  return { dark, problems };
}

const ruleMatches = (r, el) =>
  (!r.tag || r.tag === el.tag) &&
  r.conds.every(([k, v]) => (v === null ? k in el.a : el.a[k] === v));

// ---- computed properties ---------------------------------------------------------------

const INHERITED = new Set([
  "fill",
  "stroke",
  "fill-opacity",
  "stroke-opacity",
  "color",
]);

// the value declared on this element for a theme: style attr > dark rule > attribute
function declared(el, prop, theme, ctx) {
  if (el.style && prop in el.style) return el.style[prop];
  if (theme === "dark") {
    let v;
    for (const r of ctx.dark)
      if (prop in r.props && ruleMatches(r, el)) v = r.props[prop];
    if (v !== undefined) return v;
  }
  return el.a[prop];
}

// inherited property: nearest ancestor-or-self that declares it
function computed(el, prop, theme, ctx) {
  for (let p = el; p && p.tag !== "#root"; p = p.parent) {
    const v = declared(p, prop, theme, ctx);
    if (v !== undefined && v !== "inherit") return v;
    if (!INHERITED.has(prop)) return undefined;
  }
  return undefined;
}

const NUM = (v) => (v === undefined ? NaN : parseFloat(v));
const KEYWORD_PX = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
};

// font-size in px; NaN when the value cannot be read
function fontSize(el, ctx) {
  if (!el || el.tag === "#root") return 16;
  const parent = fontSize(el.parent, ctx);
  const raw = declared(el, "font-size", "light", ctx);
  if (raw === undefined || raw === "inherit") return parent;
  const v = raw.trim().toLowerCase();
  if (v in KEYWORD_PX) return KEYWORD_PX[v];
  if (v === "smaller") return parent / 1.2;
  if (v === "larger") return parent * 1.2;
  const m = /^([\d.]+)\s*(px|pt|pc|em|rem|ex|%|in|cm|mm)?$/.exec(v);
  if (!m) return NaN;
  const n = +m[1];
  const k = {
    px: 1,
    pt: 4 / 3,
    pc: 16,
    em: parent,
    rem: 16,
    ex: parent / 2,
    "%": parent / 100,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
  };
  return n * k[m[2] || "px"];
}

// product of `opacity` on the element and its ancestors
function groupOpacity(el, theme, ctx) {
  let k = 1;
  for (let p = el; p && p.tag !== "#root"; p = p.parent) {
    const v = declared(p, "opacity", theme, ctx);
    if (v !== undefined && Number.isFinite(parseFloat(v))) k *= parseFloat(v);
  }
  return k;
}

// effective { raw, color } of fill/stroke in a theme; raw undefined when never declared
function paint(el, attr, theme, ctx) {
  let raw = computed(el, attr, theme, ctx);
  if (raw === undefined) return { raw, color: null };
  if (/^currentcolor$/i.test(raw))
    raw = computed(el, "color", theme, ctx) ?? "#000000";
  let color = parseColor(raw);
  if (color) {
    const op = parseFloat(computed(el, `${attr}-opacity`, theme, ctx));
    color = withAlpha(
      color,
      (Number.isFinite(op) ? op : 1) * groupOpacity(el, theme, ctx),
    );
  }
  return { raw, color };
}
const isNone = (raw) => raw === undefined || /^none$/i.test(raw.trim());

// accumulated translate() of the element and its ancestors; other transforms → notes
function offset(el, notes) {
  let x = 0;
  let y = 0;
  for (let p = el; p && p.tag !== "#root"; p = p.parent) {
    const t = p.a.transform;
    if (!t) continue;
    for (const f of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
      if (f[1] === "translate") {
        const [a, b] = f[2]
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        x += a || 0;
        y += b || 0;
      } else notes.add(`${f[1]}() transform on <${p.tag}> is not applied`);
    }
  }
  return [x, y];
}

// ---- the audit ---------------------------------------------------------------------------

const SHAPES = new Set([
  "rect",
  "circle",
  "ellipse",
  "polyline",
  "polygon",
  "line",
  "path",
]);

export function auditSvg(
  svg,
  { minText = 9, minBoxText = 11, gridColor = GRID_COLOR } = {},
) {
  for (const [name, v] of [
    ["minText", minText],
    ["minBoxText", minBoxText],
  ])
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new TypeError(
        `auditSvg: ${name} must be a non-negative number, got ${v}`,
      );
  const grid = parseColor(gridColor);
  if (!grid)
    throw new TypeError(
      `auditSvg: gridColor must be a colour, got ${gridColor}`,
    );

  const out = [];
  const notes = new Set();
  const done = () => Object.assign(out, { notes: [...notes] });

  const { root, styles } = parseSvg(svg);
  const svgEl = root.kids.find((k) => k.tag === "svg");
  if (!svgEl) {
    out.push("not an SVG: no <svg> root element");
    return done();
  }
  const sheet = parseStylesheets(styles);
  const ctx = { dark: sheet.dark };
  for (const p of sheet.problems) out.push(p);

  // canvas size: width/height attributes (px) or the viewBox
  const vb = (svgEl.a.viewBox || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite);
  const dim = (v, fromVb) => {
    const m = /^\s*([\d.]+)\s*(?:px)?\s*$/.exec(v ?? "");
    return m ? +m[1] : hasVb ? fromVb : null;
  };
  const W = dim(svgEl.a.width, vb[2]);
  const H = dim(svgEl.a.height, vb[3]);
  const originX = hasVb ? vb[0] : 0;
  const originY = hasVb ? vb[1] : 0;

  // drawn elements, in document order (not <defs>, clip paths or masks)
  const shapes = [];
  const texts = [];
  const hidden = new Set([
    "defs",
    "clipPath",
    "mask",
    "pattern",
    "symbol",
    "marker",
  ]);
  const visit = (el) => {
    for (const k of el.kids) {
      if (k.text !== undefined || hidden.has(k.tag)) continue;
      if (k.tag === "use") notes.add("<use> references are not followed");
      if (SHAPES.has(k.tag)) shapes.push(k);
      else if (k.tag === "text") texts.push(k);
      visit(k);
    }
  };
  visit(svgEl);

  const geom = (e) => {
    const [dx, dy] = offset(e, notes);
    return {
      e,
      x: (NUM(e.a.x) || 0) + dx,
      y: (NUM(e.a.y) || 0) + dy,
      w: NUM(e.a.width),
      h: NUM(e.a.height),
    };
  };
  const sizeIs = (v, total) =>
    v !== undefined &&
    (v.trim() === "100%" ||
      (total !== null && Math.abs(parseFloat(v) - total) < 0.5));

  // the page: the first filled rect that covers the whole canvas, else the fallback
  const bgRect = shapes.find((e) => {
    if (e.tag !== "rect") return false;
    const g = geom(e);
    return (
      Math.abs(g.x - originX) < 0.5 &&
      Math.abs(g.y - originY) < 0.5 &&
      sizeIs(e.a.width, W) &&
      sizeIs(e.a.height, H) &&
      !isNone(paint(e, "fill", "light", ctx).raw)
    );
  });
  const page = {};
  for (const theme of ["light", "dark"]) {
    const f = bgRect ? paint(bgRect, "fill", theme, ctx).color : null;
    page[theme] = f ? over(f, FALLBACK_PAGE[theme]) : FALLBACK_PAGE[theme];
    if (!f) notes.add(FALLBACK_NOTE);
  }

  const rects = shapes
    .filter(
      (e) =>
        e.tag === "rect" &&
        e !== bgRect &&
        !isNone(paint(e, "fill", "light", ctx).raw),
    )
    .map(geom)
    .filter((r) => r.w > 3 && r.h > 3);

  // ---- text: every <text> and <tspan> run
  const runs = [];
  for (const t of texts) {
    const collect = (el) => {
      const own = el.kids
        .filter((k) => k.text !== undefined)
        .map((k) => k.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (own) runs.push({ el, s: own, root: t });
      for (const k of el.kids)
        if (k.text === undefined && (k.tag === "tspan" || k.tag === "textPath"))
          collect(k);
    };
    collect(t);
  }
  const attrUp = (run, name) => {
    for (let p = run.el; p; p = p.parent) {
      if (p.a[name] !== undefined)
        return NUM(p.a[name].trim().split(/[\s,]+/)[0]);
      if (p === run.root) break;
    }
    return NaN;
  };
  for (const run of runs) {
    const [dx, dy] = offset(run.el, notes);
    const x = attrUp(run, "x") + dx;
    const y = attrUp(run, "y") + dy;
    const size = fontSize(run.el, ctx);
    if (!Number.isFinite(size)) {
      out.push(
        `"${run.s}" has a font-size the audit cannot read (${declared(run.el, "font-size", "light", ctx)})`,
      );
      continue;
    }
    const shown = Math.round(size * 100) / 100;
    if (size < minText)
      out.push(`"${run.s}" is ${shown}px (floor ${minText}px)`);
    // the smallest filled rect drawn under the text's anchor point
    const under = rects
      .filter(
        (r) =>
          x > r.x &&
          x < r.x + r.w &&
          y - size * 0.35 > r.y &&
          y - size * 0.35 < r.y + r.h,
      )
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    const isBox =
      under &&
      !isNone(paint(under.e, "stroke", "light", ctx).raw) &&
      under.w > 40 &&
      under.h > 20;
    if (isBox && size < minBoxText)
      out.push(
        `"${run.s}" is ${shown}px inside a figure box (floor ${minBoxText}px)`,
      );
    for (const theme of ["light", "dark"]) {
      // an unset fill is SVG's initial black in either theme; only a rule or an ancestor recolours it
      const p = paint(run.el, "fill", theme, ctx);
      if (!isNone(p.raw) && !p.color) {
        out.push(
          `${theme}: "${run.s}" has a fill the audit cannot read (${p.raw})`,
        );
        continue;
      }
      if (isNone(p.raw) && p.raw !== undefined) continue; // fill:none draws nothing
      const ink = p.color || {
        rgb: [0, 0, 0],
        a: groupOpacity(run.el, theme, ctx),
      };
      let bg = page[theme];
      if (under) {
        const f = paint(under.e, "fill", theme, ctx).color;
        if (f) bg = over(f, bg);
      }
      const c = contrast(over(ink, bg), bg);
      if (c < 4.5)
        out.push(
          `${theme}: "${run.s}" ${p.raw ?? "(default black)"} at ${c.toFixed(2)}:1 (needs 4.5:1)`,
        );
    }
  }

  // ---- non-text marks: series lines, arrows and edges, dots (filled or hollow), solid
  // bars, and small stroke-only tiles. Exempt: boxes that frame text (a container
  // border), stripes ≤3px, and hairlines drawn in the grid colour (gridlines and rules
  // are decoration; the axis labels carry the values).
  const marks = [];
  for (const e of shapes) {
    if (e === bgRect) continue;
    const stroke = paint(e, "stroke", "light", ctx);
    const fill = paint(e, "fill", "light", ctx);
    const stroked = !isNone(stroke.raw);
    const filled = !isNone(fill.raw);
    const gridHairline =
      stroked &&
      ["line", "path", "polyline"].includes(e.tag) &&
      stroke.color &&
      stroke.color.rgb.every((c, i) => c === grid.rgb[i]);
    if (e.tag === "circle" || e.tag === "ellipse") {
      if (filled) marks.push([e, "fill"]);
      if (stroked) marks.push([e, "stroke"]);
    } else if (["polyline", "line", "path", "polygon"].includes(e.tag)) {
      if (stroked && !gridHairline) marks.push([e, "stroke"]);
      if (["path", "polygon"].includes(e.tag) && filled)
        marks.push([e, "fill"]); // arrowheads
    } else if (e.tag === "rect") {
      const w = NUM(e.a.width);
      const h = NUM(e.a.height);
      if (!(w > 3 && h > 3)) continue;
      if (stroked && w <= 24 && h <= 24)
        marks.push([e, "stroke"]); // a tile's outline
      else if (filled && fill.color && fill.color.a >= 1 && !stroked)
        marks.push([e, "fill"]);
    }
  }
  for (const [e, attr] of marks) {
    for (const theme of ["light", "dark"]) {
      const p = paint(e, attr, theme, ctx);
      if (isNone(p.raw)) continue;
      if (!p.color) {
        notes.add(
          `<${e.tag}> ${attr} ${p.raw} is not a colour the audit can read (skipped)`,
        );
        continue;
      }
      if (p.color.a < 1) continue;
      const c = contrast(p.color.rgb, page[theme]);
      // the page-coloured fill (a hollow dot's centre) is not a mark
      if (c === 1) continue;
      if (c < 3)
        out.push(
          `${theme}: ${e.tag} ${attr} ${p.raw} at ${c.toFixed(2)}:1 (marks need 3:1)`,
        );
    }
  }
  return done();
}

// ---- CLI ---------------------------------------------------------------------------------

function main(argv) {
  const usage = () => {
    console.error(
      "usage: node svg-audit.mjs [--min-text N] [--min-box-text N] [--grid-color COLOR] chart.svg...",
    );
    process.exit(2);
  };
  const opt = { minText: 9, minBoxText: 11, gridColor: GRID_COLOR };
  const files = [];
  const value = (args, i, flag) => {
    const eq = args[i].indexOf("=");
    if (eq > 0) return [args[i].slice(eq + 1), i];
    if (i + 1 >= args.length) {
      console.error(`${flag} needs a value`);
      usage();
    }
    return [args[i + 1], i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].split("=")[0];
    if (flag === "--min-text" || flag === "--min-box-text") {
      let v;
      [v, i] = value(argv, i, flag);
      if (v.trim() === "" || !Number.isFinite(+v) || +v < 0) {
        console.error(`${flag} must be a non-negative number, got "${v}"`);
        usage();
      }
      opt[flag === "--min-text" ? "minText" : "minBoxText"] = +v;
    } else if (flag === "--grid-color") {
      let v;
      [v, i] = value(argv, i, flag);
      if (!parseColor(v)) {
        console.error(`--grid-color must be a hex or rgb() colour, got "${v}"`);
        usage();
      }
      opt.gridColor = v;
    } else if (argv[i].startsWith("--") || argv[i] === "-h") usage();
    else files.push(argv[i]);
  }
  if (!files.length) usage();
  let bad = 0;
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch (e) {
      console.error(`${f}: ${e.message}`);
      process.exit(2);
    }
    const issues = auditSvg(src, opt);
    if (issues.length) bad++;
    const lines = [...issues, ...issues.notes.map((n) => `note: ${n}`)];
    console.log(
      `${issues.length ? "FAIL" : "ok  "} ${f}${lines.length ? "\n  " + lines.join("\n  ") : ""}`,
    );
  }
  process.exit(bad ? 1 : 0);
}

// run as a CLI, including through a symlink (argv[1] is the link, import.meta.url the target)
const isMain = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));
