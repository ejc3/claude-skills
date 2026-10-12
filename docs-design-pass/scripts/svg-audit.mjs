#!/usr/bin/env node
// Static legibility audit of a rendered chart SVG, in both themes: every text's size,
// every text's contrast against what is drawn behind it, and every non-text mark's
// contrast against what is drawn under it. The dark theme is the SVG's own
// `@media (prefers-color-scheme: dark)` rules applied to the elements they select,
// so the audit checks what a GitHub dark-mode reader sees.
//
//   node svg-audit.mjs [--min-text 9] [--min-box-text 11] [--grid-color #e4e8ec] chart.svg...
//   import { auditSvg } from "./svg-audit.mjs"   (for a repo's own test)
//
// Exits 1 when any file has an issue, 2 on a usage or read error. -h/--help prints usage.
// Text needs 4.5:1, marks 3:1 (WCAG 2.x).
//
// The audit certifies only the subset of SVG it models exactly (SUBSET below) and reports
// every construct outside it as an issue ("unsupported ...: the audit cannot verify it"):
//   - elements: svg, g, a, rect, circle, ellipse, line, polyline, polygon, path, text,
//     style, title, desc, and defs whose content nothing references;
//   - path data: M L H V Z, absolute or relative, so a path's extent is its vertices;
//   - transform: translate() only, accumulated through ancestors;
//   - no clip-path, mask, filter, markers, display/visibility, text stroke, per-glyph
//     placement (dx, dy, rotate, x/y lists, textLength, writing-mode, letter-spacing);
//   - opacity on a <g>/<a> only when its subtree paints one element (group compositing is
//     not modelled); opacity, fill-opacity and stroke-opacity on a shape or text.
// What is read: presentation attributes, `style="..."` attributes, and the dark rules
// (`@media (prefers-color-scheme: dark){ tag[attr="value"]{prop:value} }`, any
// whitespace, any number of rules and blocks). fill, stroke, font-size and the like
// inherit through ancestors, with SVG's initial values when nothing declares them (an
// unset fill is black, so a shape with no fill is a black box or mark); lengths and
// font-size take px or a unitless number. A stylesheet rule the audit cannot interpret
// (class or bare-tag selector, a rule outside the dark block, another @media) is reported.
// Colours read: #rgb[a], #rrggbb[aa], the 148 CSS named colours, rgb()/rgba()/hsl()/hsla()
// (comma or space separated, `/` alpha, % channels, hue units). Any other paint on a
// painted element (a gradient `url(#g)`, `var(...)`, `color(...)`, `lab()`) is an issue.
// Overlapping dark rules resolve by specificity (attribute conditions (0,1,0) each, a tag
// name (0,0,1)), source order breaking ties. `!important` is not modelled.
// One paint stack, in document order. A text's box is estimated from its anchor,
// text-anchor, font-size and per-glyph cells: Arial's and Arial Bold's advance widths
// (the metrics Helvetica and Liberation Sans share), widened 10% because system-ui can
// resolve to a wider face (DejaVu Sans runs about 13% wider than Arial). Its backdrop is
// the default page and every filled rect drawn before it that holds all its glyphs; a
// rect fill or a stroke (other than a grid hairline) drawn before it under only some
// glyphs is composited both ways, so the text must read on either side. A filled non-rect
// shape drawn before it under a glyph, and anything painted after it over a glyph, are
// issues. A mark's backdrop at each of its sample points (vertices, segment midpoints,
// centres) is the default page and every fill drawn before it that contains the point.
// An element with an effective alpha of 0 paints nothing and is ignored.
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
  "font-weight": { inherit: true, initial: "normal" },
  "text-anchor": { inherit: true, initial: "start" },
  "stroke-width": { inherit: true, initial: "1" },
  "stroke-linecap": { inherit: true, initial: "butt" },
  "stroke-linejoin": { inherit: true, initial: "miter" },
  "stroke-miterlimit": { inherit: true, initial: "4" },
  "fill-rule": { inherit: true, initial: "nonzero" },
  color: { inherit: true, initial: "black" },
};

// ---- the supported subset ----------------------------------------------------------------
// What the audit models exactly. Anything else in the drawn tree is an issue.
const SUBSET = {
  // drawn shapes → the channels they paint, in report order
  shapes: new Map(
    Object.entries({
      rect: ["fill", "stroke"],
      circle: ["fill", "stroke"],
      ellipse: ["fill", "stroke"],
      polyline: ["stroke", "fill"],
      polygon: ["stroke", "fill"],
      path: ["stroke", "fill"],
      line: ["stroke"],
    }),
  ),
  // transparent containers below the root <svg>
  containers: new Set(["g", "a"]),
  // not drawn; <defs> only while nothing references its content
  inert: new Set(["style", "title", "desc", "defs"]),
  // straight segments only: a path's extent is exactly its vertices
  pathCommands: new Set([..."MmLlHhVvZz"]),
  // attributes and properties whose effect is not modelled, on any element
  props: new Set([
    "clip-path",
    "clip",
    "mask",
    "filter",
    "marker",
    "marker-start",
    "marker-mid",
    "marker-end",
    "display",
    "visibility",
    "mix-blend-mode",
    "paint-order",
    "dx",
    "dy",
    "rotate",
    "textLength",
    "lengthAdjust",
    "writing-mode",
    "letter-spacing",
    "word-spacing",
    "baseline-shift",
    "dominant-baseline",
    "alignment-baseline",
  ]),
};
// shapes whose grid-coloured stroke is a gridline or rule
const HAIRLINES = new Set(["line", "path", "polyline"]);

const lum = ([r, g, b]) => {
  const f = (c) => (
    (c /= 255),
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// the 148 CSS named colours (CSS Color 4), name:rrggbb
const NAMED = Object.fromEntries(
  `
    148
    aliceblue:f0f8ff, antiquewhite:faebd7, aqua:00ffff, aquamarine:7fffd4,
    azure:f0ffff, beige:f5f5dc, bisque:ffe4c4, black:000000,
    blanchedalmond:ffebcd, blue:0000ff, blueviolet:8a2be2, brown:a52a2a,
    burlywood:deb887, cadetblue:5f9ea0, chartreuse:7fff00, chocolate:d2691e,
    coral:ff7f50, cornflowerblue:6495ed, cornsilk:fff8dc, crimson:dc143c,
    cyan:00ffff, darkblue:00008b, darkcyan:008b8b, darkgoldenrod:b8860b,
    darkgray:a9a9a9, darkgreen:006400, darkgrey:a9a9a9, darkkhaki:bdb76b,
    darkmagenta:8b008b, darkolivegreen:556b2f, darkorange:ff8c00,
    darkorchid:9932cc, darkred:8b0000, darksalmon:e9967a, darkseagreen:8fbc8f,
    darkslateblue:483d8b, darkslategray:2f4f4f, darkslategrey:2f4f4f,
    darkturquoise:00ced1, darkviolet:9400d3, deeppink:ff1493,
    deepskyblue:00bfff, dimgray:696969, dimgrey:696969, dodgerblue:1e90ff,
    firebrick:b22222, floralwhite:fffaf0, forestgreen:228b22, fuchsia:ff00ff,
    gainsboro:dcdcdc, ghostwhite:f8f8ff, gold:ffd700, goldenrod:daa520,
    gray:808080, green:008000, greenyellow:adff2f, grey:808080, honeydew:f0fff0,
    hotpink:ff69b4, indianred:cd5c5c, indigo:4b0082, ivory:fffff0, khaki:f0e68c,
    lavender:e6e6fa, lavenderblush:fff0f5, lawngreen:7cfc00,
    lemonchiffon:fffacd, lightblue:add8e6, lightcoral:f08080, lightcyan:e0ffff,
    lightgoldenrodyellow:fafad2, lightgray:d3d3d3, lightgreen:90ee90,
    lightgrey:d3d3d3, lightpink:ffb6c1, lightsalmon:ffa07a,
    lightseagreen:20b2aa, lightskyblue:87cefa, lightslategray:778899,
    lightslategrey:778899, lightsteelblue:b0c4de, lightyellow:ffffe0,
    lime:00ff00, limegreen:32cd32, linen:faf0e6, magenta:ff00ff, maroon:800000,
    mediumaquamarine:66cdaa, mediumblue:0000cd, mediumorchid:ba55d3,
    mediumpurple:9370db, mediumseagreen:3cb371, mediumslateblue:7b68ee,
    mediumspringgreen:00fa9a, mediumturquoise:48d1cc, mediumvioletred:c71585,
    midnightblue:191970, mintcream:f5fffa, mistyrose:ffe4e1, moccasin:ffe4b5,
    navajowhite:ffdead, navy:000080, oldlace:fdf5e6, olive:808000,
    olivedrab:6b8e23, orange:ffa500, orangered:ff4500, orchid:da70d6,
    palegoldenrod:eee8aa, palegreen:98fb98, paleturquoise:afeeee,
    palevioletred:db7093, papayawhip:ffefd5, peachpuff:ffdab9, peru:cd853f,
    pink:ffc0cb, plum:dda0dd, powderblue:b0e0e6, purple:800080,
    rebeccapurple:663399, red:ff0000, rosybrown:bc8f8f, royalblue:4169e1,
    saddlebrown:8b4513, salmon:fa8072, sandybrown:f4a460, seagreen:2e8b57,
    seashell:fff5ee, sienna:a0522d, silver:c0c0c0, skyblue:87ceeb,
    slateblue:6a5acd, slategray:708090, slategrey:708090, snow:fffafa,
    springgreen:00ff7f, steelblue:4682b4, tan:d2b48c, teal:008080,
    thistle:d8bfd8, tomato:ff6347, turquoise:40e0d0, violet:ee82ee,
    wheat:f5deb3, white:ffffff, whitesmoke:f5f5f5, yellow:ffff00,
    yellowgreen:9acd32,
  `
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((e) => e.split(":")),
);

// a channel as a number (0-255 scale) or a percentage of that scale
const channel = (t) => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(t);
  if (!m) return NaN;
  return Math.min(255, Math.max(0, m[2] ? (+m[1] * 255) / 100 : +m[1]));
};
const alphaOf = (t) => {
  if (t === undefined) return 1;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(t);
  if (!m) return NaN;
  return Math.min(1, Math.max(0, m[2] ? +m[1] / 100 : +m[1]));
};
const hueOf = (t) => {
  const m =
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i.exec(t);
  if (!m) return NaN;
  const k = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[
    (m[2] || "deg").toLowerCase()
  ];
  return (((+m[1] * k) % 360) + 360) % 360;
};
const pctOf = (t) => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)%?$/i.exec(t);
  return m ? Math.min(100, Math.max(0, +m[1])) / 100 : NaN;
};
const hslToRgb = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
};

// rgb()/rgba()/hsl()/hsla(), comma or space separated, `/` alpha → { rgb, a } or null
const parseFunc = (s) => {
  const m = /^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/i.exec(s);
  if (!m) return null;
  const hsl = m[1].toLowerCase().startsWith("hsl");
  let parts;
  let alpha;
  if (m[2].includes(",")) {
    if (m[2].includes("/")) return null;
    parts = m[2].split(/\s*,\s*/);
    if (parts.length === 4) alpha = parts.pop();
  } else {
    const [main, a, ...extra] = m[2].split(/\s*\/\s*/);
    if (extra.length) return null;
    parts = main.split(/\s+/);
    alpha = a;
  }
  if (parts.length !== 3) return null;
  const a = alphaOf(alpha);
  let rgb;
  if (hsl) {
    const h = hueOf(parts[0]);
    // a bare number is read as a percentage, as CSS Color 4 does
    const [sat, lig] = parts
      .slice(1)
      .map((t) => pctOf(/%$/.test(t) ? t : `${t}%`));
    rgb = [h, sat, lig].some(Number.isNaN) ? null : hslToRgb(h, sat, lig);
  } else rgb = parts.map(channel);
  return !rgb || [...rgb, a].some(Number.isNaN) ? null : { rgb, a };
};

// colour string → { rgb, a } (null for none / transparent / unparsable)
const parseColor = (s) => {
  s = typeof s === "string" ? s.trim() : s;
  if (!s || /^(none|transparent)$/i.test(s)) return null;
  if (/^[a-z]+$/i.test(s)) {
    const h = NAMED[s.toLowerCase()];
    return h ? parseColor(`#${h}`) : null;
  }
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    // #rgb[a] → #rrggbb[aa]
    const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return {
      rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)),
      a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1,
    };
  }
  return parseFunc(s);
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
    // the most specific matching rule; a later rule wins a tie
    let v;
    let best = [-1, -1];
    for (const r of ctx.dark) {
      if (!(prop in r.props) || !ruleMatches(r, el)) continue;
      const spec = [r.conds.length, r.tag ? 1 : 0];
      if (spec[0] > best[0] || (spec[0] === best[0] && spec[1] >= best[1])) {
        best = spec;
        v = r.props[prop];
      }
    }
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

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const NUMBER_RE = new RegExp(`^${NUMBER}$`, "i");
const numberOr = (v, dflt) =>
  Number.isFinite(parseFloat(v)) ? parseFloat(v) : dflt;

// font-size in px: px or a unitless number; NaN for any other form
const fontPx = (raw) => {
  const m = /^(\d+\.?\d*|\.\d+)(?:px)?$/i.exec(raw.trim());
  return m ? +m[1] : NaN;
};

// a length in user units: a number or px, or a % of `total` when it is known; else NaN
const lengthOf = (v, total) => {
  if (v === undefined) return 0;
  const m = new RegExp(`^\\s*(${NUMBER})(px|%)?\\s*$`, "i").exec(v);
  if (!m) return NaN;
  if (m[2] === "%") return total == null ? NaN : (+m[1] * total) / 100;
  return +m[1];
};

// a transform attribute of translate() functions → { xy }, else { bad: the first other part }
const parseTransform = (t) => {
  const re = /\s*,?\s*([A-Za-z]+)\s*\(([^)]*)\)/y;
  let x = 0;
  let y = 0;
  let m;
  let at = 0;
  while ((m = re.exec(t))) {
    at = re.lastIndex;
    const args = m[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (
      m[1] !== "translate" ||
      args.length < 1 ||
      args.length > 2 ||
      !args.every((a) => NUMBER_RE.test(a))
    )
      return { bad: m[0].trim().replace(/^,\s*/, "") };
    x += +args[0];
    y += +(args[1] ?? 0);
  }
  return t.slice(at).trim() ? { bad: `"${t}"` } : { xy: [x, y] };
};

// path data of straight segments → { subpaths: [{ pts, closed }] }, else { bad }
const parsePath = (d) => {
  const toks = d.match(new RegExp(`[A-Za-z]|${NUMBER}`, "gi")) ?? [];
  if (d.replace(new RegExp(`[A-Za-z]|${NUMBER}|[\\s,]`, "gi"), ""))
    return { bad: `"${d}"` };
  const subpaths = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let cmd = null;
  for (let i = 0; i < toks.length;) {
    if (/[A-Za-z]/.test(toks[i])) {
      cmd = toks[i++];
      if (!SUBSET.pathCommands.has(cmd)) return { bad: `command ${cmd}` };
      if (/z/i.test(cmd)) {
        if (cur) {
          cur.closed = true;
          [x, y] = cur.pts[0];
          cur = null;
        }
        continue;
      }
    } else if (!cmd || /z/i.test(cmd)) return { bad: `"${d}"` };
    const rel = cmd === cmd.toLowerCase();
    const n = /[hv]/i.test(cmd) ? 1 : 2;
    const args = toks.slice(i, i + n).map(Number);
    if (args.length < n || args.some(Number.isNaN)) return { bad: `"${d}"` };
    i += n;
    const from = [x, y];
    const up = cmd.toUpperCase();
    if (up === "H") x = rel ? x + args[0] : args[0];
    else if (up === "V") y = rel ? y + args[0] : args[0];
    else [x, y] = rel ? [x + args[0], y + args[1]] : args;
    if (up === "M") {
      cur = { pts: [[x, y]], closed: false };
      subpaths.push(cur);
      // pairs after a moveto are linetos
      cmd = rel ? "l" : "L";
    } else {
      if (!cur) {
        // a segment after Z starts a new subpath at the closed one's start
        cur = { pts: [from], closed: false };
        subpaths.push(cur);
      }
      cur.pts.push([x, y]);
    }
  }
  return { subpaths };
};

// advance widths of ASCII 32-126 in Arial and Arial Bold, in 1/1000 em
const widths = (t) => t.trim().split(/\s+/).map(Number);
const ADVANCE = widths(`
  278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556
  556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278
  500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469
  556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500
  278 556 500 722 500 500 500 334 260 334 584`);
const ADVANCE_BOLD = widths(`
  278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556
  556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278
  556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584
  556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556
  333 611 556 778 556 556 500 389 280 389 584`);
// the same for punctuation and symbols charts use outside ASCII: regular[, bold]
const ADVANCE_MORE = {
  "\u00a0": [278],
  "·": [333],
  "×": [584],
  "–": [556],
  "—": [1000],
  "−": [584],
  "±": [549],
  "≥": [549],
  "≤": [549],
  "…": [1000],
  "→": [1000],
  "←": [1000],
  "°": [400],
  µ: [576],
  "•": [350],
  "‘": [222, 278],
  "’": [222, 278],
  "“": [333, 500],
  "”": [333, 500],
};
// how far ASCII glyphs reach below the baseline in Arial, as a share of the font size;
// the rest reach 0.03 below it (round overshoot)
const DESCENDERS = {
  g: 0.21,
  j: 0.21,
  p: 0.21,
  q: 0.21,
  y: 0.21,
  Q: 0.06,
  $: 0.08,
  ",": 0.15,
  ";": 0.15,
  _: 0.15,
  "(": 0.21,
  ")": 0.21,
  "[": 0.21,
  "]": 0.21,
  "{": 0.21,
  "}": 0.21,
  "|": 0.21,
  "@": 0.21,
};
// a text's glyph cells, relative to its start: per character its advance (Arial's or
// Arial Bold's from the tables above; 0.6 em for other characters, 1 em for East Asian
// wide ones), widened 10% for the system-ui fonts charts name ahead of Arial, and its
// reach above and below the baseline (0.75 em above for the tabled glyphs; others 0.95
// above and 0.25 below, for accents and shapes the tables do not know). A combining mark
// widens the reach of its base glyph.
const glyphCells = (s, px, weight) => {
  const bold = /^(bold|bolder)$/i.test(weight) || +weight >= 600;
  const k = px * 1.1;
  const cells = [];
  let x = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const ascii = c >= 32 && c <= 126;
    const more = ADVANCE_MORE[ch];
    const known = ascii || more !== undefined;
    const up = (known ? 0.75 : 0.95) * px;
    const down = (known ? (DESCENDERS[ch] ?? 0.03) : 0.25) * px;
    if (/\p{M}/u.test(ch)) {
      const base = cells[cells.length - 1];
      if (base) {
        base.up = Math.max(base.up, up);
        base.down = Math.max(base.down, down);
      }
      continue;
    }
    const adv = ascii
      ? (bold ? ADVANCE_BOLD : ADVANCE)[c - 32] / 1000
      : more
        ? more[bold ? more.length - 1 : 0] / 1000
        : c >= 0x2e80 && c <= 0xffdc
          ? 1
          : 0.6;
    cells.push({ x0: x * k, x1: (x + adv) * k, up, down, ink: /\S/u.test(ch) });
    x += adv;
  }
  return { width: x * k, cells };
};

// boxes are [x0, y0, x1, y1]
const overlaps = (a, b) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const grow = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
const corners = (b) => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[0], b[3]],
  [b[2], b[3]],
];

// does the fill of a shape's geometry contain the point (a closed boundary counts)?
const inside = (g, px, py, rule) => {
  const [x0, y0, x1, y1] = g.box;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  if (g.kind === "rect") {
    if (!(g.rx > 0 && g.ry > 0)) return true;
    const ex = Math.max(
      0,
      Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - g.rx),
    );
    const ey = Math.max(
      0,
      Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - g.ry),
    );
    return (ex / g.rx) ** 2 + (ey / g.ry) ** 2 <= 1;
  }
  if (g.kind === "ellipse")
    return ((px - g.cx) / g.rx) ** 2 + ((py - g.cy) / g.ry) ** 2 <= 1;
  // straight-edged: every subpath closed for filling, winding and crossings counted
  let winding = 0;
  let crossings = 0;
  for (const { pts } of g.subpaths)
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if (ay <= py === by <= py) continue;
      if (ax + ((py - ay) / (by - ay)) * (bx - ax) > px) {
        crossings++;
        winding += by > ay ? 1 : -1;
      }
    }
  return rule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
};
// a convex shape (rect, ellipse) contains a box when it contains its four corners
const containsBox = (g, b) => corners(b).every(([x, y]) => inside(g, x, y));
// the same rect or ellipse shrunk by d on every side (its stroke's inner edge)
const shrink = (g, d) => {
  const box = [g.box[0] + d, g.box[1] + d, g.box[2] - d, g.box[3] - d];
  if (box[0] > box[2] || box[1] > box[3]) return null;
  return g.kind === "rect"
    ? { ...g, box, rx: Math.max(0, g.rx - d), ry: Math.max(0, g.ry - d) }
    : { ...g, box, rx: g.rx - d, ry: g.ry - d };
};

// does the segment a-b meet the box? (Liang-Barsky clipping)
const segmentMeets = ([ax, ay], [bx, by], [x0, y0, x1, y1]) => {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      t0 = Math.max(t0, r);
    } else {
      if (r < t0) return false;
      t1 = Math.min(t1, r);
    }
  }
  return true;
};
// the distance between the segment a-b and the box (0 when they meet)
const segmentToBox = (a, b, box) => {
  if (segmentMeets(a, b, box)) return 0;
  const toPoint = ([px, py]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2
      ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2))
      : 0;
    return Math.hypot(a[0] + t * dx - px, a[1] + t * dy - py);
  };
  const toBox = ([px, py]) =>
    Math.hypot(
      Math.max(box[0] - px, 0, px - box[2]),
      Math.max(box[1] - py, 0, py - box[3]),
    );
  return Math.min(toBox(a), toBox(b), ...corners(box).map(toPoint));
};
const pointIn = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
// does the fill of an ellipse meet the box? (the box's point nearest its centre is inside)
const ellipseMeets = (cx, cy, rx, ry, [x0, y0, x1, y1]) =>
  ((Math.min(Math.max(cx, x0), x1) - cx) / rx) ** 2 +
    ((Math.min(Math.max(cy, y0), y1) - cy) / ry) ** 2 <=
  1;
// does the fill of a (rounded) rect meet the box? its cross of straight edges, or a
// corner ellipse
const rectMeets = (g, b) => {
  if (!overlaps(g.box, b)) return false;
  if (!(g.rx > 0 && g.ry > 0)) return true;
  const [x0, y0, x1, y1] = g.box;
  const { rx, ry } = g;
  return (
    overlaps([x0 + rx, y0, x1 - rx, y1], b) ||
    overlaps([x0, y0 + ry, x1, y1 - ry], b) ||
    [
      [x0 + rx, y0 + ry],
      [x1 - rx, y0 + ry],
      [x0 + rx, y1 - ry],
      [x1 - rx, y1 - ry],
    ].some(([cx, cy]) => ellipseMeets(cx, cy, rx, ry, b))
  );
};
// does the fill of a straight-edged shape meet the box? a vertex is in it, an edge
// crosses it, or it lies inside the fill
const polyMeets = (g, b, rule) =>
  g.subpaths.some(({ pts }) =>
    pts.some(
      (p, i) => pointIn(p, b) || segmentMeets(p, pts[(i + 1) % pts.length], b),
    ),
  ) || corners(b).some(([x, y]) => inside(g, x, y, rule));

const article = (tag) => (/^[aeiou]/.test(tag) ? `an ${tag}` : `a ${tag}`);
const isNone = (raw) => /^(none|transparent)$/i.test(raw.trim());

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
  // an issue about the SVG's structure, reported once however often it is met
  const seen = new Set();
  const unsupported = (what) => {
    const msg = `unsupported ${what}: the audit cannot verify it`;
    if (!seen.has(msg)) out.push(msg);
    seen.add(msg);
  };

  const { root, styles } = parseSvg(svg);
  const svgEl = root.kids.find((k) => k.tag === "svg");
  if (!svgEl) {
    out.push("not an SVG: no <svg> root element");
    return done();
  }
  const sheet = parseStylesheets(styles);
  const ctx = { dark: sheet.dark };
  for (const p of sheet.problems) out.push(p);
  for (const r of sheet.dark)
    for (const k of Object.keys(r.props))
      if (SUBSET.props.has(k) || k === "transform")
        unsupported(`${k} in the dark rules`);

  // canvas size: width/height attributes (px) or the viewBox
  const vb = (svgEl.a.viewBox || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite);
  const px = (v) => {
    const m = /^\s*([\d.]+)\s*(?:px)?\s*$/.exec(v ?? "");
    return m ? +m[1] : null;
  };
  const W = px(svgEl.a.width) ?? (hasVb ? vb[2] : null);
  const H = px(svgEl.a.height) ?? (hasVb ? vb[3] : null);
  const originX = hasVb ? vb[0] : 0;
  const originY = hasVb ? vb[1] : 0;
  // a viewBox drawn at another size scales every length, font sizes included
  if (hasVb && (Math.abs(W - vb[2]) > 0.5 || Math.abs(H - vb[3]) > 0.5))
    unsupported(`viewBox scaling (${vb[2]}x${vb[3]} drawn at ${W}x${H})`);

  // ---- the drawn tree, in paint order; anything outside the subset is reported
  const drawn = [];
  const defsIds = new Map();
  const checkAttrs = (el) => {
    for (const k of SUBSET.props)
      if (el.a[k] !== undefined || (el.style && k in el.style))
        unsupported(`${k} on <${el.tag}>`);
    if (el.style && "transform" in el.style)
      unsupported(`transform in the style attribute of <${el.tag}>`);
    if (el.a.transform !== undefined) {
      const t = parseTransform(el.a.transform);
      if (t.bad) unsupported(`transform ${t.bad} on <${el.tag}>`);
      else el.shift = t.xy;
    }
  };
  const collectIds = (el) => {
    for (const k of el.kids)
      if (k.tag) {
        if (k.a.id) defsIds.set(k.a.id, k.tag);
        collectIds(k);
      }
  };
  const visit = (el) => {
    for (const k of el.kids) {
      if (k.text !== undefined) continue;
      if (k.tag === "defs") collectIds(k);
      if (SUBSET.inert.has(k.tag)) continue;
      checkAttrs(k);
      if (SUBSET.containers.has(k.tag)) visit(k);
      else if (SUBSET.shapes.has(k.tag) || k.tag === "text") {
        k.ord = drawn.length;
        drawn.push(k);
        for (const c of k.kids)
          if (c.tag && c.tag !== "title" && c.tag !== "desc")
            unsupported(`<${c.tag}>`);
      } else unsupported(`<${k.tag}>`);
    }
  };
  checkAttrs(svgEl);
  visit(svgEl);
  // content of <defs> is not drawn unless something references it
  if (defsIds.size) {
    const refs = new Set();
    const scan = (s) => {
      for (const m of s.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) refs.add(m[1]);
    };
    const walk = (el) => {
      for (const k of el.kids)
        if (k.tag) {
          for (const [n, v] of Object.entries(k.a)) {
            scan(v);
            if (/(^|:)href$/.test(n) && v.startsWith("#")) refs.add(v.slice(1));
          }
          walk(k);
        }
    };
    walk(root);
    styles.forEach(scan);
    for (const id of refs)
      if (defsIds.has(id))
        unsupported(`reference to #${id}, a <${defsIds.get(id)}> in <defs>`);
  }
  // painted elements under each container, for its opacity
  for (const d of drawn)
    for (let p = d.parent; p && p.tag !== "#root"; p = p.parent)
      p.painted = (p.painted ?? 0) + 1;

  // ---- computed values, cached per element and theme

  const memo = (el, key, f) => {
    el.memo ??= new Map();
    if (!el.memo.has(key)) el.memo.set(key, f());
    return el.memo.get(key);
  };
  // an opacity-like value in [0, 1]; an unreadable one is reported and read as 1
  const alphaProp = (el, prop, theme) => {
    const v = computed(el, prop, theme, ctx).trim();
    const a = alphaOf(v);
    if (!Number.isNaN(a)) return a;
    unsupported(`${prop} "${v}" on <${el.tag}>`);
    return 1;
  };
  // the containers' opacity: modelled for one painted descendant only
  const groupAlpha = (el, theme) => {
    let k = 1;
    for (let p = el.parent; p && p.tag !== "#root"; p = p.parent) {
      const a = alphaProp(p, "opacity", theme);
      if (a !== 1 && p.painted > 1)
        unsupported(
          `opacity on <${p.tag}> over ${p.painted} painted elements (group compositing is not modelled)`,
        );
      k *= a;
    }
    return k;
  };
  // effective { raw, color, alpha } of fill or stroke in a theme; alpha 0 paints
  // nothing, NaN is a paint the audit cannot read
  const paintOf = (el, attr, theme) =>
    memo(el, `${attr} ${theme}`, () => {
      let raw = computed(el, attr, theme, ctx);
      if (/^currentcolor$/i.test(raw)) raw = computed(el, "color", theme, ctx);
      let color = parseColor(raw);
      if (color)
        color = withAlpha(
          color,
          alphaProp(el, `${attr}-opacity`, theme) *
            alphaProp(el, "opacity", theme) *
            groupAlpha(el, theme),
        );
      return { raw, color, alpha: isNone(raw) ? 0 : color ? color.a : NaN };
    });
  const len = (el, name, total) => {
    const v = lengthOf(el.a[name], total);
    if (!Number.isNaN(v)) return v;
    unsupported(`${name}="${el.a[name]}" on <${el.tag}>`);
    return 0;
  };
  const offset = (el) => {
    let x = 0;
    let y = 0;
    for (const p of chain(el))
      if (p.shift) {
        x += p.shift[0];
        y += p.shift[1];
      }
    return [x, y];
  };
  const pointsOf = (s) => {
    const n = (s ?? "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (n.length % 2 || n.some(Number.isNaN)) return null;
    const pts = [];
    for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    return pts;
  };
  // a shape's geometry with the translates applied: { kind, box, ... }; box is null
  // when the shape draws nothing
  const geom = (e) =>
    memo(e, "geom", () => {
      const [dx, dy] = offset(e);
      const at = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
      let subpaths;
      if (e.tag === "rect") {
        const x = len(e, "x", W) + dx;
        const y = len(e, "y", H) + dy;
        const w = len(e, "width", W);
        const h = len(e, "height", H);
        if (!(w > 0 && h > 0)) return { kind: "rect", box: null, w: 0, h: 0 };
        let rx = e.a.rx === undefined ? undefined : len(e, "rx", W);
        let ry = e.a.ry === undefined ? undefined : len(e, "ry", H);
        rx ??= ry ?? 0;
        ry ??= rx;
        return {
          kind: "rect",
          box: [x, y, x + w, y + h],
          w,
          h,
          rx: Math.min(rx, w / 2),
          ry: Math.min(ry, h / 2),
        };
      }
      if (e.tag === "circle" || e.tag === "ellipse") {
        const cx = len(e, "cx", W) + dx;
        const cy = len(e, "cy", H) + dy;
        const rx = len(e, e.tag === "circle" ? "r" : "rx", W);
        const ry = len(e, e.tag === "circle" ? "r" : "ry", H);
        if (!(rx > 0 && ry > 0)) return { kind: "ellipse", box: null };
        return {
          kind: "ellipse",
          box: [cx - rx, cy - ry, cx + rx, cy + ry],
          cx,
          cy,
          rx,
          ry,
        };
      }
      if (e.tag === "line")
        subpaths = [
          {
            pts: at([
              [len(e, "x1", W), len(e, "y1", H)],
              [len(e, "x2", W), len(e, "y2", H)],
            ]),
            closed: false,
          },
        ];
      else if (e.tag === "path") {
        const p = parsePath(e.a.d ?? "");
        if (p.bad) {
          unsupported(`path ${p.bad} on <path>`);
          return { kind: "poly", box: null };
        }
        subpaths = p.subpaths.map((s) => ({ ...s, pts: at(s.pts) }));
      } else {
        const pts = pointsOf(e.a.points);
        if (!pts) {
          unsupported(`points="${e.a.points}" on <${e.tag}>`);
          return { kind: "poly", box: null };
        }
        subpaths = [{ pts: at(pts), closed: e.tag === "polygon" }];
      }
      const all = subpaths.flatMap((s) => s.pts);
      if (!all.length) return { kind: "poly", box: null };
      const xs = all.map((p) => p[0]);
      const ys = all.map((p) => p[1]);
      return {
        kind: "poly",
        box: [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ],
        subpaths,
      };
    });
  // how far a shape's stroke reaches outside its geometry: half the width, more at a
  // square cap or a mitred join (the miter's own length, up to the miter limit)
  const strokeReach = (e, theme) =>
    memo(e, `reach ${theme}`, () => {
      const raw = computed(e, "stroke-width", theme, ctx);
      let w = fontPx(raw);
      if (Number.isNaN(w)) {
        unsupported(`stroke-width "${raw}" on <${e.tag}>`);
        w = 1;
      }
      let k = 1;
      if (computed(e, "stroke-linecap", theme, ctx).trim() === "square")
        k = Math.SQRT2;
      const g = geom(e);
      if (
        g.kind === "poly" &&
        g.box &&
        computed(e, "stroke-linejoin", theme, ctx).trim() === "miter"
      ) {
        const limit = numberOr(computed(e, "stroke-miterlimit", theme, ctx), 4);
        for (const { pts, closed } of g.subpaths)
          for (let i = 0; i < pts.length; i++) {
            if (!closed && (i === 0 || i === pts.length - 1)) continue;
            const a = pts[(i - 1 + pts.length) % pts.length];
            const b = pts[i];
            const c = pts[(i + 1) % pts.length];
            const u = Math.atan2(a[1] - b[1], a[0] - b[0]);
            const v = Math.atan2(c[1] - b[1], c[0] - b[0]);
            const ratio = 1 / Math.abs(Math.sin((u - v) / 2));
            if (Number.isFinite(ratio) && ratio <= limit)
              k = Math.max(k, ratio);
          }
      }
      return (w / 2) * k;
    });
  const fillRule = (e, theme) =>
    memo(e, `rule ${theme}`, () => computed(e, "fill-rule", theme, ctx).trim());
  // the box a channel can paint in a theme, stroke reach included; null when it paints
  // nothing (alpha 0, or no geometry)
  const reachBox = (e, attr, theme) =>
    memo(e, `reach box ${attr} ${theme}`, () => {
      const g = geom(e);
      if (!g.box || paintOf(e, attr, theme).alpha === 0) return null;
      return attr === "fill" ? g.box : grow(g.box, strokeReach(e, theme));
    });
  // does a channel paint inside the box b? Exact for the subset's geometry: a stroke is
  // every point within its reach of the outline (a butt cap is counted as round), and a
  // rect or ellipse stroke leaves its inner region free
  const meets = (e, attr, theme, b) => {
    const r = reachBox(e, attr, theme);
    if (!r || !overlaps(r, b)) return false;
    const g = geom(e);
    if (attr === "fill")
      return g.kind === "rect"
        ? rectMeets(g, b)
        : g.kind === "ellipse"
          ? ellipseMeets(g.cx, g.cy, g.rx, g.ry, b)
          : polyMeets(g, b, fillRule(e, theme));
    const d = strokeReach(e, theme);
    if (g.kind === "poly")
      return g.subpaths.some(({ pts, closed }) =>
        pts.some(
          (p, i) =>
            (closed || i < pts.length - 1 || pts.length === 1) &&
            segmentToBox(p, pts[(i + 1) % pts.length], b) <= d,
        ),
      );
    const outer =
      g.kind === "rect"
        ? rectMeets(
            { ...g, rx: g.rx && g.rx + d, ry: g.ry && g.ry + d, box: r },
            b,
          )
        : ellipseMeets(g.cx, g.cy, g.rx + d, g.ry + d, b);
    const inner = shrink(g, d);
    return outer && !(inner && containsBox(inner, b));
  };

  const isCanvas = (e) => {
    if (e.tag !== "rect") return false;
    const g = geom(e);
    return (
      g.box !== null &&
      W !== null &&
      H !== null &&
      Math.abs(g.box[0] - originX) < 0.5 &&
      Math.abs(g.box[1] - originY) < 0.5 &&
      Math.abs(g.w - W) < 0.5 &&
      Math.abs(g.h - H) < 0.5
    );
  };
  const shapes = drawn.filter((e) => e.tag !== "text");
  const texts = drawn.filter((e) => e.tag === "text");

  // ---- every painted channel must be readable, in each theme
  for (const theme of THEMES) {
    for (const e of shapes)
      for (const attr of SUBSET.shapes.get(e.tag)) {
        const p = paintOf(e, attr, theme);
        if (!Number.isNaN(p.alpha) || !geom(e).box) continue;
        out.push(
          isCanvas(e) && attr === "fill"
            ? `${theme}: full-canvas rect fill ${p.raw} cannot be read: the page colour is unknown`
            : `${theme}: ${e.tag} ${attr} has a colour the audit cannot read (${p.raw})`,
        );
      }
    if (
      !shapes.some((e) => isCanvas(e) && paintOf(e, "fill", theme).alpha !== 0)
    )
      notes.add(FALLBACK_NOTE);
  }

  // ---- text: size, backdrop, and nothing drawn over it
  const content = (t) =>
    t.kids
      .filter((k) => k.text !== undefined)
      .map((k) => k.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const anchorOf = (t) =>
    memo(t, "anchor", () => {
      for (const n of ["x", "y"])
        if ((t.a[n] ?? "").trim().split(/[\s,]+/).length > 1)
          unsupported(`${n} list on <text>`);
      const [dx, dy] = offset(t);
      const first = (n, total) => {
        const v = lengthOf(t.a[n]?.trim().split(/[\s,]+/)[0], total);
        if (!Number.isNaN(v)) return v;
        unsupported(`${n}="${t.a[n]}" on <text>`);
        return 0;
      };
      return [first("x", W) + dx, first("y", H) + dy];
    });
  // the estimated glyph boxes of a text in a theme ({ box, cells }: their union and the
  // inked ones); null when its size cannot be read or nothing is inked
  const textBox = (t, theme) =>
    memo(t, `box ${theme}`, () => {
      const size = fontPx(computed(t, "font-size", theme, ctx));
      if (!Number.isFinite(size)) return null;
      const { width, cells } = glyphCells(
        content(t),
        size,
        computed(t, "font-weight", theme, ctx).trim(),
      );
      const anchor = computed(t, "text-anchor", theme, ctx).trim();
      const share = { start: 0, middle: 0.5, end: 1 }[anchor];
      if (share === undefined) unsupported(`text-anchor "${anchor}"`);
      const [x, y] = anchorOf(t);
      const x0 = x - width * (share ?? 0);
      const inked = cells
        .filter((c) => c.ink)
        .map((c) => [x0 + c.x0, y - c.up, x0 + c.x1, y + c.down]);
      if (!inked.length) return null;
      return {
        box: [0, 1, 2, 3].map((i) =>
          (i < 2 ? Math.min : Math.max)(...inked.map((c) => c[i])),
        ),
        cells: inked,
      };
    });
  // does a channel paint over any of a text's glyphs?
  const meetsText = (e, attr, theme, tb) =>
    overlaps(reachBox(e, attr, theme) ?? [0, 0, 0, 0], tb.box) &&
    tb.cells.some((c) => meets(e, attr, theme, c));
  // drawn text with something to show
  const shown = texts.filter((t) => content(t));

  // rects that carry a fill in either theme, for the figure-box floor
  const rects = shapes
    .filter(
      (e) =>
        e.tag === "rect" &&
        !isCanvas(e) &&
        THEMES.some((t) => paintOf(e, "fill", t).alpha !== 0),
    )
    .filter((e) => geom(e).w > 3 && geom(e).h > 3);
  // a gridline or rule: a line, path or polyline stroked in the grid colour
  const isGridHairline = (e) => {
    if (!HAIRLINES.has(e.tag)) return false;
    const c = paintOf(e, "stroke", "light").color;
    return c !== null && c.rgb.every((v, i) => v === grid.rgb[i]);
  };
  // a partial layer is composited both ways, so their count is capped
  const MAX_PARTIAL = 8;

  for (const t of shown) {
    const s = content(t);
    const [x, y] = anchorOf(t);
    const sizeRaw = (theme) => computed(t, "font-size", theme, ctx);
    const size = fontPx(sizeRaw("light"));
    // a figure box: the smallest filled rect around the text's anchor, stroked, over 40x20
    const around = rects.filter((r) => {
      const [x0, y0, x1, y1] = geom(r).box;
      const ay = y - size * 0.35;
      return x > x0 && x < x1 && ay > y0 && ay < y1;
    });
    const underAll = [...around].sort(
      (a, b) => geom(a).w * geom(a).h - geom(b).w * geom(b).h,
    );
    const under =
      underAll.find((r) => paintOf(r, "fill", "light").alpha !== 0) ??
      underAll[0];
    const isBox =
      under &&
      paintOf(under, "stroke", "light").alpha !== 0 &&
      geom(under).w > 40 &&
      geom(under).h > 20;
    for (const theme of THEMES) {
      // the dark size is only audited when a dark rule changes it
      if (theme === "dark" && sizeRaw("dark") === sizeRaw("light")) continue;
      const pre = theme === "dark" ? "dark: " : "";
      const px = fontPx(sizeRaw(theme));
      if (!Number.isFinite(px)) {
        out.push(
          `${pre}"${s}" has a font-size the audit cannot read (${sizeRaw(theme)})`,
        );
        continue;
      }
      const shownPx = Math.round(px * 100) / 100;
      if (px < minText)
        out.push(`${pre}"${s}" is ${shownPx}px (floor ${minText}px)`);
      if (isBox && px < minBoxText)
        out.push(
          `${pre}"${s}" is ${shownPx}px inside a figure box (floor ${minBoxText}px)`,
        );
    }
    for (const theme of THEMES) {
      if (paintOf(t, "stroke", theme).alpha !== 0)
        unsupported(`stroke on <text> "${s}"`);
      const p = paintOf(t, "fill", theme);
      if (p.alpha === 0) continue; // fill:none draws nothing
      if (!p.color) {
        out.push(
          `${theme}: "${s}" has a fill the audit cannot read (${p.raw})`,
        );
        continue;
      }
      const tb = textBox(t, theme);
      if (!tb) continue;
      // the backdrop: what is painted before the text under its glyphs. A rect fill that
      // holds every glyph is always behind it; a rect fill or a stroke under some glyphs
      // is behind those only, so the text is checked with and without each one. A grid
      // hairline is decoration, as for marks.
      const full = [];
      const partial = [];
      for (const e of shapes) {
        if (e.ord > t.ord) break;
        for (const attr of SUBSET.shapes.get(e.tag)) {
          if (!meetsText(e, attr, theme, tb)) continue;
          const f = paintOf(e, attr, theme);
          if (!f.color) {
            out.push(
              `${theme}: "${s}" sits on ${article(e.tag)} with a ${attr} the audit cannot read (${f.raw})`,
            );
            continue;
          }
          if (attr === "stroke" && isGridHairline(e)) continue;
          const layer = { ord: e.ord + (attr === "stroke" ? 0.5 : 0), f };
          if (attr === "stroke" || e.tag === "rect")
            (attr === "fill" && containsBox(geom(e), tb.box)
              ? full
              : partial
            ).push(layer);
          else
            out.push(
              `${theme}: "${s}" is drawn over ${article(e.tag)} (fill ${f.raw}): the audit cannot verify how much of it the ${e.tag} covers`,
            );
        }
      }
      if (partial.length > MAX_PARTIAL) {
        out.push(
          `${theme}: "${s}" is over ${partial.length} shapes that each cover part of it: the audit cannot verify it`,
        );
        continue;
      }
      let worst = Infinity;
      for (let mask = 0; mask < 1 << partial.length; mask++) {
        const layers = [...full, ...partial.filter((_, i) => mask & (1 << i))];
        layers.sort((a, b) => a.ord - b.ord);
        let bg = FALLBACK_PAGE[theme];
        for (const l of layers) bg = over(l.f.color, bg);
        worst = Math.min(worst, contrast(over(p.color, bg), bg));
      }
      if (worst < 4.5)
        out.push(
          `${theme}: "${s}" ${p.raw} at ${worst.toFixed(2)}:1 (needs 4.5:1)`,
        );
      // anything painted after the text over its glyphs hides what the reader sees
      for (const e of drawn) {
        if (e.ord <= t.ord) continue;
        let cover = null;
        if (e.tag === "text") {
          const later = content(e) && textBox(e, theme);
          if (
            later &&
            paintOf(e, "fill", theme).alpha !== 0 &&
            overlaps(later.box, tb.box) &&
            later.cells.some((c) => tb.cells.some((d) => overlaps(c, d)))
          )
            cover = "fill";
        } else
          cover = SUBSET.shapes
            .get(e.tag)
            .find((attr) => meetsText(e, attr, theme, tb));
        if (cover)
          out.push(
            `${theme}: "${s}" is covered by ${article(e.tag)} drawn after it (${cover} ${paintOf(e, cover, theme).raw}): the audit cannot verify it`,
          );
      }
    }
  }

  // ---- non-text marks: series lines, arrows and edges, dots (filled or hollow), solid
  // bars, and small stroke-only tiles. Exempt: the fill of a full-canvas rect (the
  // page), rects that frame text (a container or a heat-table cell: some rendered text's
  // anchor lies inside it; the text is measured against it instead), labeled swatches
  // (a legend key), stripes ≤3px, hairlines drawn in the grid colour (gridlines and
  // rules are decoration; the axis labels carry the values), and a fill that composites
  // to the colour under it (a hollow dot's centre). A translucent colour (rgba,
  // fill/stroke-opacity, opacity) is composited over the colour under it before the 3:1
  // check, at each of the mark's sample points.
  const anchors = [];
  for (const t of shown) {
    if (isNone(paintOf(t, "fill", "light").raw)) continue;
    const [x, y] = anchorOf(t);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const size = fontPx(computed(t, "font-size", "light", ctx));
    anchors.push([x, y - (Number.isFinite(size) ? size : 0) * 0.35, y]);
  }
  const framesText = (e) => {
    const [x0, y0, x1, y1] = geom(e).box;
    return anchors.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1);
  };
  // a labeled swatch (a legend key): a rect no larger than 32x20 with a rendered text
  // starting within 12px of its right edge, the baseline within 4px of its vertical
  // extent. The adjacent text carries what the graphic shows (WCAG 1.4.11).
  const isLabeledSwatch = (e) => {
    const g = geom(e);
    if (g.w > 32 || g.h > 20) return false;
    const [x0, y0, x1, y1] = g.box;
    return anchors.some(
      ([x, , base]) =>
        x >= x1 && x <= x1 + 12 && base >= y0 - 4 && base <= y1 + 4,
    );
  };
  // where the colour under a mark is read: on the stroke's line, inside the fill
  const samples = (e, attr) => {
    const g = geom(e);
    const [x0, y0, x1, y1] = g.box;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    if (g.kind === "rect") {
      const i = Math.min(0.5, g.w / 2, g.h / 2);
      const edges = (d) => [
        [x0 + d, cy],
        [x1 - d, cy],
        [cx, y0 + d],
        [cx, y1 - d],
      ];
      return attr === "fill" ? [[cx, cy], ...edges(i)] : edges(0);
    }
    if (g.kind === "ellipse") {
      const k = attr === "fill" ? 0.5 : 1;
      const ring = [
        [g.cx - g.rx * k, g.cy],
        [g.cx + g.rx * k, g.cy],
        [g.cx, g.cy - g.ry * k],
        [g.cx, g.cy + g.ry * k],
      ];
      return attr === "fill" ? [[g.cx, g.cy], ...ring] : ring;
    }
    // a point moved toward another by up to half a pixel: a sample on a boundary the
    // mark only touches (an arrow ending at a box edge) reads the side the ink is on
    const toward = (a, b) => {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const k = d ? Math.min(0.5, d / 2) / d : 0;
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    };
    const pts = [];
    for (const { pts: v, closed } of g.subpaths) {
      if (!v.length) continue;
      if (attr === "fill") {
        // inside the fill: its centroid and each vertex moved toward it
        const c = [
          v.reduce((s, p) => s + p[0], 0) / v.length,
          v.reduce((s, p) => s + p[1], 0) / v.length,
        ];
        pts.push(c, ...v.map((p) => toward(p, c)));
        continue;
      }
      // on the stroke: each vertex (an open end moved along its segment) and midpoint
      const n = v.length;
      v.forEach((p, i) =>
        pts.push(
          closed || n < 2 || (i > 0 && i < n - 1)
            ? p
            : toward(p, v[i === 0 ? 1 : n - 2]),
        ),
      );
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const [a, b] = [v[i], v[(i + 1) % n]];
        pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    }
    return pts;
  };
  // the colour under a point, from the fills painted before paint order `ord`
  const fills = Object.fromEntries(
    THEMES.map((theme) => [
      theme,
      shapes.filter(
        (e) =>
          SUBSET.shapes.get(e.tag).includes("fill") &&
          geom(e).box &&
          paintOf(e, "fill", theme).color?.a > 0,
      ),
    ]),
  );
  const colourAt = (theme, ord, [x, y]) => {
    let bg = FALLBACK_PAGE[theme];
    for (const e of fills[theme]) {
      if (e.ord >= ord) break;
      if (inside(geom(e), x, y, fillRule(e, theme)))
        bg = over(paintOf(e, "fill", theme).color, bg);
    }
    return bg;
  };
  const checkMark = (e, attr) => {
    const g = geom(e);
    if (!g.box) return;
    if (e.tag === "rect") {
      if (attr === "fill" && isCanvas(e)) return;
      if (!(g.w > 3 && g.h > 3)) return;
      if (framesText(e) || isLabeledSwatch(e)) return;
    }
    if (attr === "stroke" && isGridHairline(e)) return;
    for (const theme of THEMES) {
      const p = paintOf(e, attr, theme);
      if (!(p.alpha > 0)) continue; // paints nothing, or reported as unreadable
      let worst = Infinity;
      for (const pt of samples(e, attr)) {
        const bg = colourAt(theme, e.ord, pt);
        const c = contrast(over(p.color, bg), bg);
        if (c !== 1) worst = Math.min(worst, c);
      }
      if (worst < 3) {
        const alpha =
          p.color.a < 1 ? ` (${Math.round(p.color.a * 100)}% opaque)` : "";
        out.push(
          `${theme}: ${e.tag} ${attr} ${p.raw}${alpha} at ${worst.toFixed(2)}:1 (marks need 3:1)`,
        );
      }
    }
  };
  for (const e of shapes)
    for (const attr of SUBSET.shapes.get(e.tag)) checkMark(e, attr);
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
