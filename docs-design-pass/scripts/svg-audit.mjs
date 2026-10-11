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
// Exits 1 when any file has an issue, 2 on a usage or read error. -h/--help prints usage.
// Text needs 4.5:1, marks 3:1 (WCAG 2.x).
//
// What is read: presentation attributes, `style="..."` attributes, and the dark rules
// (`@media (prefers-color-scheme: dark){ tag[attr="value"]{prop:value} }`, any
// whitespace, any number of rules and blocks). fill, stroke, font-size and the opacities
// inherit through <g>/<text>/<tspan> ancestors, with SVG's initial values when nothing
// declares them (an unset fill is black, so a shape with no fill is a black box or mark);
// font-size takes px or a unitless number, any other form is reported as unreadable;
// <tspan> runs are audited on their own; translate() transforms offset the geometry.
// A stylesheet rule the audit cannot interpret (class or bare-tag selector,
// a rule outside the dark block, another @media) is reported as an issue, never dropped.
// Not modelled: rotate/scale/matrix transforms, <use>, gradients (reported as notes).
//
// auditSvg returns the issue strings; `.notes` on the returned array lists the
// assumptions made (for example the page colour used when the SVG draws no background).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const THEMES = ["light", "dark"];
// the page behind an SVG that draws no background rect of its own
const FALLBACK_PAGE = { light: [255, 255, 255], dark: [13, 17, 23] };
const FALLBACK_NOTE =
  "no background rect: assuming a #ffffff page in light and #0d1117 in dark";

// SVG properties the audit reads: inherited or not, and the initial value that applies
// when neither the element, an ancestor nor a rule declares one
const PROPS = {
  fill: { inherit: true, initial: "black" },
  stroke: { inherit: true, initial: "none" },
  "fill-opacity": { inherit: true, initial: "1" },
  "stroke-opacity": { inherit: true, initial: "1" },
  opacity: { inherit: false, initial: "1" },
  "font-size": { inherit: true, initial: "16" },
  color: { inherit: true, initial: "black" },
};
// shape → the channels it paints, in report order
const PAINTS = new Map(
  Object.entries({
    rect: ["fill", "stroke"],
    circle: ["fill", "stroke"],
    ellipse: ["fill", "stroke"],
    polyline: ["stroke", "fill"],
    polygon: ["stroke", "fill"],
    path: ["stroke", "fill"],
    line: ["stroke"],
  }),
);
// not drawn: definitions, clip paths, masks
const HIDDEN = new Set([
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "symbol",
  "marker",
]);
// shapes whose grid-coloured stroke is a gridline or rule
const HAIRLINES = new Set(["line", "path", "polyline"]);
// children of <text> that carry text of their own
const TEXT_KIDS = new Set(["tspan", "textPath"]);

const lum = ([r, g, b]) => {
  const f = (c) => (
    (c /= 255),
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// colour string → { rgb, a } (null for none / unparsable)
const parseColor = (s) => {
  s = typeof s === "string" ? s.trim() : s;
  if (!s || /^(none|transparent)$/i.test(s)) return null;
  if (/^black$/i.test(s)) return { rgb: [0, 0, 0], a: 1 };
  if (/^white$/i.test(s)) return { rgb: [255, 255, 255], a: 1 };
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    // #rgb[a] → #rrggbb[aa]
    const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return {
      rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)),
      a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1,
    };
  }
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

// the element and its ancestors, up to (not including) the root
function* chain(el) {
  for (let p = el; p && p.tag !== "#root"; p = p.parent) yield p;
}

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

// one attribute condition: [name], [name=v], [name="v"], [name='v'] → name, value
const COND = String.raw`\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]`;
const SELECTOR = new RegExp(String.raw`^(\*|[a-zA-Z][\w-]*)?((?:${COND})+)$`);
const CONDS = new RegExp(COND, "g");

// `tag[attr="v"]`, `[attr='v']`, `rect[fill=#fff][stroke]` → { tag, conds } or null
const parseSelector = (sel) => {
  const m = SELECTOR.exec(sel.trim());
  if (!m) return null;
  const conds = [...m[2].matchAll(CONDS)].map((c) => [
    c[1],
    c[2] ?? c[3] ?? c[4] ?? null,
  ]);
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
      if (brace < 0) {
        problems.push(`unsupported "${css.slice(i).trim()}": not applied`);
        break;
      }
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

// the value in effect: this element's, else (for inherited properties) the nearest
// ancestor's, else the property's initial value. Never undefined.
function computed(el, prop, theme, ctx) {
  const { inherit, initial } = PROPS[prop];
  for (const p of chain(el)) {
    const v = declared(p, prop, theme, ctx);
    if (v !== undefined && v !== "inherit") return v;
    if (!inherit) break;
  }
  return initial;
}

const NUM = (v) => (v === undefined ? NaN : parseFloat(v));
const numberOr = (v, dflt) =>
  Number.isFinite(parseFloat(v)) ? parseFloat(v) : dflt;

// font-size in px: px or a unitless number; NaN for any other form
const fontPx = (raw) => {
  const m = /^(\d+\.?\d*|\.\d+)(?:px)?$/i.exec(raw.trim());
  return m ? +m[1] : NaN;
};

// product of `opacity` on the element and its ancestors
const groupOpacity = (el, theme, ctx) => {
  let k = 1;
  for (const p of chain(el))
    k *= numberOr(computed(p, "opacity", theme, ctx), 1);
  return k;
};

// effective { raw, color } of fill/stroke in a theme
function paint(el, attr, theme, ctx) {
  let raw = computed(el, attr, theme, ctx);
  if (/^currentcolor$/i.test(raw)) raw = computed(el, "color", theme, ctx);
  let color = parseColor(raw);
  if (color)
    color = withAlpha(
      color,
      numberOr(computed(el, `${attr}-opacity`, theme, ctx), 1) *
        groupOpacity(el, theme, ctx),
    );
  return { raw, color };
}
const isNone = (raw) => /^none$/i.test(raw.trim());

// accumulated translate() of the element and its ancestors; other transforms → notes
function offset(el, notes) {
  let x = 0;
  let y = 0;
  for (const p of chain(el)) {
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

export function auditSvg(
  svg,
  { minText = 9, minBoxText = 11, gridColor = "#e4e8ec" } = {},
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
  const visit = (el) => {
    for (const k of el.kids) {
      if (k.text !== undefined || HIDDEN.has(k.tag)) continue;
      if (k.tag === "use") notes.add("<use> references are not followed");
      if (PAINTS.has(k.tag)) shapes.push(k);
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
  const filled = (e) => !isNone(paint(e, "fill", "light", ctx).raw);

  // the page: the first filled rect that covers the whole canvas, else the fallback
  const bgRect = shapes.find((e) => {
    if (e.tag !== "rect") return false;
    const g = geom(e);
    return (
      Math.abs(g.x - originX) < 0.5 &&
      Math.abs(g.y - originY) < 0.5 &&
      sizeIs(e.a.width, W) &&
      sizeIs(e.a.height, H) &&
      filled(e)
    );
  });
  const page = {};
  for (const theme of THEMES) {
    const f = bgRect ? paint(bgRect, "fill", theme, ctx).color : null;
    page[theme] = f ? over(f, FALLBACK_PAGE[theme]) : FALLBACK_PAGE[theme];
    if (!f) notes.add(FALLBACK_NOTE);
  }

  const rects = shapes
    .filter((e) => e.tag === "rect" && e !== bgRect && filled(e))
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
        if (k.text === undefined && TEXT_KIDS.has(k.tag)) collect(k);
    };
    collect(t);
  }
  // an x/y attribute from the run or an ancestor up to its <text>
  const attrUp = (run, name) => {
    for (const p of chain(run.el)) {
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
    const sizeRaw = (theme) => computed(run.el, "font-size", theme, ctx);
    const size = fontPx(sizeRaw("light"));
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
    for (const theme of THEMES) {
      // the dark size is only audited when a dark rule changes it
      if (theme === "dark" && sizeRaw("dark") === sizeRaw("light")) continue;
      const pre = theme === "dark" ? "dark: " : "";
      const px = fontPx(sizeRaw(theme));
      if (!Number.isFinite(px)) {
        out.push(
          `${pre}"${run.s}" has a font-size the audit cannot read (${sizeRaw(theme)})`,
        );
        continue;
      }
      const shown = Math.round(px * 100) / 100;
      if (px < minText)
        out.push(`${pre}"${run.s}" is ${shown}px (floor ${minText}px)`);
      if (isBox && px < minBoxText)
        out.push(
          `${pre}"${run.s}" is ${shown}px inside a figure box (floor ${minBoxText}px)`,
        );
    }
    if (!Number.isFinite(size)) continue;
    for (const theme of THEMES) {
      const p = paint(run.el, "fill", theme, ctx);
      if (isNone(p.raw)) continue; // fill:none draws nothing
      if (!p.color) {
        out.push(
          `${theme}: "${run.s}" has a fill the audit cannot read (${p.raw})`,
        );
        continue;
      }
      let bg = page[theme];
      if (under) {
        const f = paint(under.e, "fill", theme, ctx).color;
        if (f) bg = over(f, bg);
      }
      const c = contrast(over(p.color, bg), bg);
      if (c < 4.5)
        out.push(
          `${theme}: "${run.s}" ${p.raw} at ${c.toFixed(2)}:1 (needs 4.5:1)`,
        );
    }
  }

  // ---- non-text marks: series lines, arrows and edges, dots (filled or hollow), solid
  // bars, and small stroke-only tiles. Exempt: rects that frame text (a container or
  // a heat-table cell: some rendered text's anchor lies inside it; the text is
  // measured against it instead), labeled swatches (a legend key), stripes ≤3px, hairlines drawn in the grid colour
  // (gridlines and rules are decoration; the axis labels carry the values), and a
  // fill that composites to the page colour (a hollow dot's centre). A translucent
  // colour (rgba, fill/stroke-opacity, an ancestor's opacity) is composited over the
  // theme's page colour before the 3:1 check.
  const anchors = [];
  for (const run of runs) {
    if (isNone(paint(run.el, "fill", "light", ctx).raw)) continue;
    const [dx, dy] = offset(run.el, notes);
    const x = attrUp(run, "x") + dx;
    const y = attrUp(run, "y") + dy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = fontPx(computed(run.el, "font-size", "light", ctx));
    anchors.push([x, y - (Number.isFinite(size) ? size : 0) * 0.35, y]);
  }
  const framesText = (e) => {
    const g = geom(e);
    return anchors.some(
      ([x, y]) => x > g.x && x < g.x + g.w && y > g.y && y < g.y + g.h,
    );
  };
  // a labeled swatch (a legend key): a rect no larger than 32x20 with a rendered text
  // starting within 12px of its right edge, the baseline within 4px of its vertical
  // extent. The adjacent text carries what the graphic shows (WCAG 1.4.11).
  const isLabeledSwatch = (e) => {
    const g = geom(e);
    if (g.w > 32 || g.h > 20) return false;
    return anchors.some(
      ([x, , base]) =>
        x >= g.x + g.w &&
        x <= g.x + g.w + 12 &&
        base >= g.y - 4 &&
        base <= g.y + g.h + 4,
    );
  };
  const checkMark = (e, attr) => {
    if (e.tag === "rect") {
      const { w, h } = geom(e);
      if (!(w > 3 && h > 3)) return;
      if (framesText(e) || isLabeledSwatch(e)) return;
    }
    if (attr === "stroke" && HAIRLINES.has(e.tag)) {
      const c = paint(e, "stroke", "light", ctx).color;
      if (c && c.rgb.every((v, i) => v === grid.rgb[i])) return;
    }
    for (const theme of THEMES) {
      const p = paint(e, attr, theme, ctx);
      if (isNone(p.raw)) continue;
      if (!p.color) {
        notes.add(
          `<${e.tag}> ${attr} ${p.raw} is not a colour the audit can read (skipped)`,
        );
        continue;
      }
      const c = contrast(over(p.color, page[theme]), page[theme]);
      if (c === 1) continue;
      if (c < 3) {
        const alpha =
          p.color.a < 1 ? ` (${Math.round(p.color.a * 100)}% opaque)` : "";
        out.push(
          `${theme}: ${e.tag} ${attr} ${p.raw}${alpha} at ${c.toFixed(2)}:1 (marks need 3:1)`,
        );
      }
    }
  };
  for (const e of shapes)
    if (e !== bgRect) for (const attr of PAINTS.get(e.tag)) checkMark(e, attr);
  return done();
}

// ---- CLI ---------------------------------------------------------------------------------

const USAGE =
  "usage: node svg-audit.mjs [--min-text N] [--min-box-text N] [--grid-color COLOR] chart.svg...";

function main(argv) {
  const fail = (msg) => {
    console.error(msg ? `${msg}\n${USAGE}` : USAGE);
    process.exit(2);
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "min-text": { type: "string" },
        "min-box-text": { type: "string" },
        "grid-color": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    fail(e.message);
  }
  const { values, positionals: files } = parsed;
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!files.length) fail();
  // only the flags given; auditSvg owns the defaults and the validation
  const num = (v) => (v.trim() === "" ? NaN : Number(v));
  const opt = {};
  if ("min-text" in values) opt.minText = num(values["min-text"]);
  if ("min-box-text" in values) opt.minBoxText = num(values["min-box-text"]);
  if ("grid-color" in values) opt.gridColor = values["grid-color"];
  let bad = 0;
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch (e) {
      console.error(`${f}: ${e.message}`);
      process.exit(2);
    }
    let issues;
    try {
      issues = auditSvg(src, opt);
    } catch (e) {
      if (e instanceof TypeError) fail(e.message);
      throw e;
    }
    if (issues.length) bad++;
    const lines = [...issues, ...issues.notes.map((n) => `note: ${n}`)];
    console.log(
      `${issues.length ? "FAIL" : "ok  "} ${f}${lines.length ? "\n  " + lines.join("\n  ") : ""}`,
    );
  }
  process.exit(bad ? 1 : 0);
}

// run as a CLI, including through a symlink (argv[1] is the link, import.meta.url the target)
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2));
