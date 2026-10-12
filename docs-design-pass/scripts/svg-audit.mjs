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
// The contract: a lint for SVG your own generators emit; not a validator for untrusted
// input. It is correct on well-formed generator output; malformed, hostile or
// adversarially sized input gets no guarantee of correctness or running time.
//
// The audit certifies only an allowlisted subset of SVG (SUBSET below: the elements,
// attributes, value forms and stylesheet forms a chart generator emits) and reports
// everything else as "unsupported ...: the audit cannot verify it". In short: a root
// <svg> whose numeric width and height equal its viewBox exactly; g (translate() only),
// a, rect, circle, line, polyline and path (M L H V Z; a fill whose outline crosses
// itself is refused), text with plain x/y and font-weight up to 700; fill, stroke,
// stroke-width, font-size, font-weight, text-anchor and font-family as attributes; one
// form of stylesheet, `@media (prefers-color-scheme: dark){ tag[fill|stroke="v"]{fill|
// stroke: colour} }`, matched after XML attribute-value normalization and entity
// decoding. No opacity in any form, no CSS comments or !important, no CDATA.
// Colours: #rgb[a], #rrggbb[aa], the 148 CSS named colours, rgb()/rgba()/hsl()/hsla()
// (the legacy comma form only as CSS Color 4 defines it).
// Input past fixed limits (size, element count, nesting, list length) is "too large".
//
// One paint stack, in document order. Backdrops come from rects: a text's or mark's
// backdrop is every colour the rects painted before it composite to over the region it
// paints (each region of the plane cut by the rects' edges is composited on its own, so
// the darkest and the lightest backdrop both count), over the theme's default page.
// A stroke drawn before a text under its glyphs is composited both ways, except a grid
// hairline; a mark is not checked against other marks' strokes under it (marks that
// cross); a stroke's own element's fill is part of its backdrop. A filled circle, path
// or polyline drawn before a text or mark it overlaps is an issue (its coverage is not
// modelled), as is anything painted after a text over its glyphs.
// A text is laid out as rsvg and Chromium both do: XML whitespace stripped at its ends
// and collapsed inside, other spaces (NBSP, U+202F) kept; a line break inside a text or
// a non-collapsible space at either end, where the two differ, is refused, and so is a
// character outside the measured glyph table. Its glyph cells are estimated per
// character from its anchor, text-anchor and font-size. Each advance lies between 90% of
// the narrower and the wider of Arial widened 10% and DejaVu Sans (regular, or for a
// weight over 500 both regular and bold), and each glyph reaches as high and as
// low as the highest and lowest of them, from Liberation Sans (Arial's metrics) and
// DejaVu Sans measured on their font files; each cell spans every place its glyph can
// land within those bounds. font-family may name only Helvetica, Arial, Liberation Sans,
// DejaVu Sans, sans-serif and the system UI faces (system-ui, -apple-system, Segoe UI),
// which are taken to fall within the same bounds, not measured. Covering is
// over-approximated where geometry is not exact: a mitred join reaches 4 half widths
// around its vertex (the default miter limit) and a rounded rect's stroke corner is taken
// as square. Such approximations can only add issues.
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
    // the legacy comma form: rgb() channels all numbers or all percentages, hsl()
    // saturation and lightness percentages
    const pct = parts.map((t) => /%$/.test(t));
    if (hsl ? !(pct[1] && pct[2]) : pct.some((p) => p !== pct[0])) return null;
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
    const name = s.toLowerCase();
    return Object.hasOwn(NAMED, name) ? parseColor(`#${NAMED[name]}`) : null;
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

const isNone = (raw) => /^(none|transparent)$/i.test(raw.trim());

// ---- the supported subset ----------------------------------------------------------------

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const isNumber = (v) => NUMBER_RE.test(v.trim());
const isSize = (v) => isNumber(v) && +v >= 0;
const isPaint = (v) => isNone(v) || parseColor(v) !== null;
const any = () => true;
const oneOf = (...words) => {
  const set = new Set(words);
  return (v) => set.has(v.trim());
};
// the font families the glyph estimate stands for (Arial's metrics and DejaVu Sans, and
// the system UI faces a chart's family list names ahead of them)
const FAMILIES = new Set([
  "system-ui",
  "-apple-system",
  "segoe ui",
  "helvetica",
  "arial",
  "liberation sans",
  "dejavu sans",
  "sans-serif",
]);
const isFamilyList = (v) =>
  v.split(",").every((f) =>
    FAMILIES.has(
      f
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .toLowerCase(),
    ),
  );
const isTranslateList = (v) =>
  new RegExp(
    `^\\s*(?:translate\\(\\s*${NUMBER}(?:\\s*,?\\s*${NUMBER})?\\s*\\)\\s*,?\\s*)+$`,
  ).test(v);
const isViewBox = (v) => {
  const n = v.trim().split(/[\s,]+/);
  return (
    n.length === 4 &&
    n.every((t) => NUMBER_RE.test(t)) &&
    +n[2] > 0 &&
    +n[3] > 0
  );
};
const SVG_NS = "http://www.w3.org/2000/svg";
const STROKED = { stroke: isPaint, "stroke-width": isSize };

const SUBSET = {
  // element → its allowed attributes and the value form each takes
  elements: {
    svg: {
      xmlns: (v) => v === SVG_NS,
      width: isSize,
      height: isSize,
      viewBox: isViewBox,
      role: any,
      "aria-label": any,
      "font-family": isFamilyList,
      style: any, // its declarations are checked against SUBSET.rootStyle
    },
    g: { transform: isTranslateList },
    a: { href: any },
    rect: {
      x: isNumber,
      y: isNumber,
      width: isSize,
      height: isSize,
      rx: isSize,
      fill: isPaint,
      ...STROKED,
    },
    circle: {
      cx: isNumber,
      cy: isNumber,
      r: isSize,
      fill: isPaint,
      ...STROKED,
    },
    line: {
      x1: isNumber,
      y1: isNumber,
      x2: isNumber,
      y2: isNumber,
      ...STROKED,
    },
    polyline: {
      points: any, // parsed with the geometry
      fill: isPaint,
      ...STROKED,
      "stroke-linejoin": oneOf("miter", "round", "bevel"),
      "stroke-linecap": oneOf("butt", "round", "square"),
    },
    path: { d: any, fill: isPaint, ...STROKED },
    text: {
      x: isNumber,
      y: isNumber,
      "font-size": isSize,
      // up to bold: a heavier face is not measured
      "font-weight": (v) =>
        /^(normal|bold|[1-9]\d{0,2})$/.test(v.trim()) && !(+v > 700),
      "text-anchor": oneOf("start", "middle", "end"),
      fill: isPaint,
    },
    style: {},
    title: {},
    desc: {},
  },
  // where each element may appear
  parents: {
    svg: ["#root"],
    g: ["svg", "g", "a"],
    a: ["svg", "g", "a"],
    rect: ["svg", "g", "a"],
    circle: ["svg", "g", "a"],
    line: ["svg", "g", "a"],
    polyline: ["svg", "g", "a"],
    path: ["svg", "g", "a"],
    text: ["svg", "g", "a"],
    style: ["svg"],
    title: [
      "svg",
      "g",
      "a",
      "rect",
      "circle",
      "line",
      "polyline",
      "path",
      "text",
    ],
    desc: [
      "svg",
      "g",
      "a",
      "rect",
      "circle",
      "line",
      "polyline",
      "path",
      "text",
    ],
  },
  // the declarations the root's style attribute may carry
  rootStyle: { "font-variant-numeric": oneOf("tabular-nums") },
  // the dark rules: selector tags and attributes, and the properties they set
  darkTags: new Set(["rect", "circle", "line", "polyline", "path", "text"]),
  darkAttrs: new Set(["fill", "stroke"]),
  darkProps: { fill: isPaint, stroke: isPaint },
  // path data: straight segments only
  pathCommands: new Set([..."MmLlHhVvZz"]),
  entities: { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" },
};
// the shapes, and the channels each paints in report order
const SHAPES = new Map(
  Object.entries({
    rect: ["fill", "stroke"],
    circle: ["fill", "stroke"],
    polyline: ["stroke", "fill"],
    path: ["stroke", "fill"],
    line: ["stroke"],
  }),
);
// shapes whose grid-coloured stroke is a gridline or rule
const HAIRLINES = new Set(["line", "path", "polyline"]);
// initial values of the properties read
const INITIAL = {
  fill: "black",
  stroke: "none",
  "stroke-width": "1",
  "stroke-linejoin": "miter",
  "stroke-linecap": "butt",
  "font-size": "16",
  "font-weight": "normal",
  "text-anchor": "start",
};
// input past these is reported as too large instead of audited
const LIMITS = {
  bytes: 4_000_000,
  elements: 20_000,
  depth: 64,
  numbers: 20_000, // in one points or d list
  textChars: 2_000,
  regions: 40_000, // backdrop regions for one text or mark
  layers: 256, // backdrop colours for one text or mark
};
// the default miter limit: how far a mitred join can reach, in half stroke widths
const MITER_LIMIT = 4;

// ---- glyph metrics --------------------------------------------------------------------------

// per character, in 1/1000 em: the widest advance (regular, bold) as the larger of Arial's
// widened 10% and DejaVu Sans'; the narrowest (regular, bold) as 90% of the smaller; the
// highest the ink reaches above and the lowest below the baseline; and the farthest it
// runs left of the advance's start and right of its end. From the glyph tables of
// Liberation Sans (Arial's metrics) and DejaVu Sans, regular and bold, for every character
// all four fonts hold in Basic Latin, Latin-1, Latin Extended-A and -B, Greek, General
// Punctuation, currency, letterlike symbols, arrows, mathematical operators and geometric
// shapes (combining marks excluded). "@hex" sets the code point of the next row.
const GLYPH_TABLE = `
  @20 318,349,250,250,0,0,0,0 401,457,250,299,730,0,0,0 460,522,319,426,730,0,0,0
  838,838,500,500,718,0,0,0 637,696,500,500,760,147,0,0 979,1002,800,800,743,15,0,0
  780,873,600,649,743,15,0,0 275,307,171,214,730,0,0,0 391,458,299,299,759,208,0,0
  391,458,299,299,759,208,0,0 500,523,350,350,743,0,0,0 838,838,525,525,627,0,0,0
  318,380,250,250,189,155,0,0 367,416,299,299,359,0,0,0 318,380,250,250,189,0,0,0
  337,366,250,250,730,93,0,0 637,696,500,500,743,15,0,0 637,696,500,500,730,0,0,0
  637,696,500,500,743,0,0,0 637,696,500,500,743,15,0,0 637,696,500,500,730,0,0,0
  637,696,500,500,730,15,0,0 637,696,500,500,743,15,0,0 637,696,500,500,730,0,0,0
  637,696,500,500,743,15,0,0 637,696,500,500,743,15,0,0 337,400,250,299,547,0,0,0
  337,400,250,299,547,155,0,0 838,838,525,525,601,0,0,0 838,838,525,525,521,0,0,0
  838,838,525,525,601,0,0,0 612,672,477,522,743,0,0,0 1117,1073,900,877,725,174,0,0
  734,795,600,649,730,0,0,0 734,795,600,649,730,0,0,0 795,795,628,649,743,15,0,0
  795,831,649,649,730,0,0,0 734,734,568,600,730,0,0,0 672,684,517,549,730,0,0,0
  856,856,697,700,743,15,0,0 795,837,649,649,730,0,0,0 306,373,250,250,730,0,0,0
  550,612,265,334,730,201,57,0 734,795,590,649,730,0,0,31 612,672,500,549,730,0,0,0
  917,996,749,749,730,0,0,0 795,837,649,649,730,0,0,0 856,856,700,700,743,15,0,0
  734,734,542,600,730,0,0,0 856,856,700,700,743,197,0,0 795,795,625,649,730,0,0,0
  734,734,571,600,743,15,0,0 672,683,549,549,730,0,3,3 795,813,649,649,730,15,0,0
  734,774,600,600,730,0,0,0 1039,1104,849,849,730,0,0,0 734,771,600,600,730,0,0,0
  734,734,549,600,730,0,10,10 686,726,549,549,730,0,0,0 391,458,250,299,760,208,0,0
  337,366,250,250,730,93,0,0 391,458,250,299,760,208,0,0 838,838,422,525,730,0,0,0
  612,612,450,450,0,236,16,12 500,500,299,299,800,0,0,0 613,675,500,500,561,15,0,7
  635,716,500,549,760,15,0,0 550,612,450,500,561,15,0,0 635,716,500,549,760,15,0,0
  616,679,500,500,561,15,0,0 353,436,250,299,760,0,0,20 635,716,500,549,561,216,0,0
  634,712,500,549,760,0,0,0 278,343,199,250,760,0,0,0 278,343,199,250,760,216,34,0
  580,666,450,500,760,0,0,20 278,343,199,250,760,0,0,0 975,1042,749,800,561,0,0,0
  634,712,500,549,561,0,0,0 612,688,500,549,561,15,0,0 635,716,500,549,561,209,0,0
  635,716,500,549,561,209,0,0 412,494,299,350,561,0,0,0 550,612,450,500,561,15,0,0
  393,479,250,299,703,9,0,0 634,712,500,549,561,15,0,0 592,652,450,500,547,0,0,0
  818,924,649,700,547,0,3,3 592,646,450,500,547,0,0,0 592,652,450,500,547,216,0,0
  550,583,450,450,547,0,0,0 637,712,300,350,760,208,0,0 337,366,233,251,765,236,0,0
  637,712,300,350,760,208,0,0 838,838,525,525,416,0,0,0 @a0 318,349,250,250,0,0,0,0
  401,457,299,299,547,183,0,0 637,696,500,500,700,153,0,0 637,696,500,500,743,0,0,0
  637,637,500,500,597,0,0,0 637,696,500,500,730,0,1,2 337,366,233,251,725,223,0,0
  612,612,450,450,743,112,0,0 500,500,299,299,774,0,0,0 1000,1000,663,663,726,8,0,0
  472,564,333,333,743,0,0,4 612,646,500,500,520,0,0,0 838,838,525,525,444,0,0,0 @ae
  1000,1000,663,663,726,8,0,0 608,608,450,450,760,0,9,9 500,500,359,359,750,0,0,0
  838,838,493,493,627,0,0,0 401,438,299,299,743,0,0,0 401,438,299,299,743,0,0,0
  500,500,299,299,800,0,0,0 637,736,518,518,547,209,0,0 637,637,483,500,730,129,0,0
  367,380,286,299,442,0,0,0 500,500,299,299,0,212,0,0 401,438,299,299,734,0,0,0
  472,564,328,328,743,0,0,0 612,646,500,500,520,0,0,0 970,1036,750,750,743,87,0,67
  970,1036,750,750,743,15,0,0 970,1036,750,750,743,87,0,67 672,672,477,522,547,197,0,0
  734,795,600,649,928,0,0,0 734,795,600,649,928,0,0,0 734,795,600,649,929,0,0,0
  734,795,600,649,932,0,0,0 734,795,600,649,928,0,0,0 734,795,600,649,929,0,0,0
  1100,1100,876,900,730,0,0,0 795,795,628,649,743,212,0,0 734,734,568,600,928,0,0,0
  734,734,568,600,928,0,0,0 734,734,568,600,929,0,0,0 734,734,568,600,928,0,0,0
  306,373,250,250,928,0,20,0 306,373,250,250,928,0,0,22 306,373,250,250,929,0,42,41
  306,373,250,250,928,0,21,21 795,838,649,649,730,0,0,0 795,837,649,649,929,0,0,0
  856,856,700,700,928,15,0,0 856,856,700,700,928,15,0,0 856,856,700,700,929,15,0,0
  856,856,700,700,929,15,0,0 856,856,700,700,928,15,0,0 838,838,525,525,607,0,0,0
  856,856,700,700,766,37,0,0 795,813,649,649,928,15,0,0 795,813,649,649,928,15,0,0
  795,813,649,649,929,15,0,0 795,813,649,649,928,15,0,0 734,734,549,600,928,0,10,10
  734,738,544,600,730,0,0,0 672,720,549,549,760,15,0,0 613,675,500,500,800,15,0,3
  613,675,500,500,800,15,0,3 613,675,500,500,800,15,0,3 613,675,500,500,778,15,0,3
  613,675,500,500,774,15,0,3 613,675,500,500,889,15,0,3 982,1048,800,800,561,15,0,0
  550,612,450,500,561,212,0,0 616,679,500,500,800,15,0,0 616,679,500,500,800,15,0,0
  616,679,500,500,800,15,0,0 616,679,500,500,774,15,0,0 306,343,250,250,800,0,32,0
  306,343,250,250,800,0,0,45 306,343,250,250,800,0,41,42 306,343,250,250,774,0,20,21
  612,688,500,549,760,15,0,0 634,712,500,549,778,0,0,0 612,688,500,549,800,15,0,0
  612,688,500,549,800,15,0,0 612,688,500,549,800,15,0,0 612,688,500,549,778,15,0,0
  612,688,500,549,774,15,0,0 838,838,493,493,585,0,0,0 672,688,549,549,595,46,0,0
  634,712,500,549,800,15,0,0 634,712,500,549,800,15,0,0 634,712,500,549,800,15,0,0
  634,712,500,549,774,15,0,0 592,652,450,500,800,216,0,0 635,716,500,549,760,209,0,0
  592,652,450,500,774,216,0,0 734,795,600,649,914,0,0,0 613,675,500,500,763,15,0,7
  734,795,600,649,947,0,0,0 613,675,500,500,780,15,0,7 734,795,600,649,730,204,0,22
  613,675,500,500,561,209,0,7 795,795,628,649,928,15,0,0 550,612,450,500,800,15,0,0
  795,795,628,649,929,15,0,0 550,612,450,500,800,15,0,0 795,795,628,649,928,15,0,0
  550,612,450,500,760,15,0,0 795,795,628,649,929,15,0,0 550,612,450,500,800,15,0,0
  795,831,649,649,929,0,0,0 677,791,553,644,760,15,0,156 795,838,649,649,730,0,0,0
  635,716,500,549,760,15,0,0 734,734,568,600,914,0,0,0 616,679,500,500,764,15,0,0
  734,734,568,600,929,0,0,0 616,679,500,500,786,15,0,0 734,734,568,600,928,0,0,0
  616,679,500,500,760,15,0,0 734,734,568,600,730,209,0,0 616,679,500,500,561,209,0,0
  734,734,568,600,928,0,0,0 616,679,500,500,800,15,0,0 856,856,697,700,929,15,0,0
  635,716,500,549,800,216,0,0 856,856,697,700,929,15,0,0 635,716,500,549,786,216,0,0
  856,856,697,700,928,15,0,0 635,716,500,549,760,216,0,0 856,856,697,700,743,250,0,0
  635,716,500,549,786,216,0,0 795,837,649,649,929,0,0,0 634,712,500,549,935,0,14,0
  917,974,649,649,730,0,0,0 695,791,500,549,760,0,0,0 306,373,250,250,929,0,51,53
  306,343,250,250,778,0,51,53 306,373,250,250,914,0,10,12 306,343,250,250,764,0,10,12
  306,373,250,250,929,0,34,35 306,343,250,250,786,0,33,36 306,373,250,250,730,209,0,0
  278,343,199,250,760,209,0,2 306,373,250,250,928,0,0,0 306,343,250,250,561,0,0,0
  809,864,530,669,730,201,0,0 556,686,399,500,760,216,0,0 550,612,265,334,929,201,57,2
  278,343,199,250,800,216,51,51 734,795,590,649,730,236,0,31
  580,666,450,500,760,236,0,20 580,666,450,500,547,0,0,20 612,672,500,549,928,0,0,0
  278,343,199,250,928,0,0,30 612,672,500,549,730,236,0,0 278,343,199,250,760,236,0,0
  612,672,500,549,730,0,0,0 375,480,262,346,760,0,0,10 612,672,500,549,730,0,0,0
  368,557,300,431,760,0,0,0 612,672,500,549,730,0,45,0 285,372,199,250,760,0,19,20
  795,837,649,649,928,0,0,0 634,712,500,549,804,0,0,0 795,837,649,649,730,236,0,0
  634,712,500,549,561,236,0,0 795,837,649,649,928,0,0,0 634,712,500,549,800,0,0,0
  814,983,543,637,730,0,11,0 796,837,650,650,743,209,0,0 634,712,500,549,561,216,0,0
  856,856,700,700,914,15,0,0 612,688,500,549,764,15,0,0 856,856,700,700,929,15,0,0
  612,688,500,549,788,15,0,0 856,856,700,700,928,15,0,0 612,688,500,549,800,15,0,0
  1100,1167,900,900,730,5,0,0 1039,1095,849,849,561,15,0,0 795,795,625,649,928,0,0,0
  412,494,299,350,804,0,0,37 795,795,625,649,730,236,0,0 412,494,299,350,561,236,0,0
  795,795,625,649,928,0,0,0 412,494,299,350,800,0,0,18 734,734,571,600,928,15,0,0
  550,612,450,500,804,15,0,0 734,734,571,600,929,15,0,0 550,612,450,500,800,15,0,0
  734,734,571,600,743,212,0,0 550,612,450,500,561,212,0,0 734,734,571,600,929,15,0,0
  550,612,450,500,800,15,0,0 672,683,549,549,730,212,3,3 393,479,250,299,703,212,0,0
  672,683,549,549,931,0,3,3 413,527,337,430,814,9,0,30 672,683,549,549,730,0,3,3
  393,479,250,299,703,9,0,0 795,813,649,649,929,15,0,0 634,712,500,549,778,15,0,0
  795,813,649,649,914,15,0,0 634,712,500,549,763,15,0,0 795,813,649,649,929,15,0,0
  634,712,500,549,786,15,0,0 795,813,649,649,966,15,0,0 634,712,500,549,882,15,0,0
  795,813,649,649,928,15,0,0 634,712,500,549,800,15,0,0 795,813,649,649,730,209,0,0
  634,712,500,549,561,209,0,4 1039,1104,849,849,932,0,0,0 818,924,649,700,804,0,3,3
  734,734,549,600,932,0,10,10 592,652,450,500,804,216,0,0 734,734,549,600,928,0,10,10
  686,726,549,549,928,0,0,0 550,583,450,450,804,0,0,0 686,726,549,549,930,0,0,0
  550,583,450,450,760,0,0,0 686,726,549,549,929,0,0,0 550,583,450,450,800,0,0,0
  353,436,199,250,760,0,0,37 635,716,500,549,760,15,0,0 835,921,661,729,730,0,69,0
  722,791,590,646,730,0,0,0 635,716,500,549,760,15,0,0 722,791,590,646,730,0,0,0
  635,716,500,549,761,15,0,0 795,795,632,649,743,15,0,0 795,795,628,649,924,15,0,96
  550,612,450,500,760,15,0,69 795,838,649,649,730,0,0,0 891,922,728,753,730,0,69,0
  722,791,590,646,730,0,0,0 635,716,500,549,760,15,0,0 613,688,500,545,561,222,0,0
  734,734,568,600,730,0,0,0 828,850,677,653,743,15,0,0 665,696,543,563,743,15,0,0
  672,684,517,549,730,208,57,0 612,612,316,391,760,212,63,20
  856,856,697,700,924,15,0,49 687,793,561,573,731,211,0,0 984,1045,792,837,760,10,0,0
  354,436,199,250,730,0,0,0 306,390,250,250,730,0,0,0 746,795,600,649,743,0,0,31
  580,666,450,500,760,0,0,20 278,361,199,250,760,0,0,0 592,612,450,500,760,0,11,0
  980,1091,801,892,730,15,0,0 795,837,649,649,730,208,57,0 634,712,500,549,561,209,0,0
  856,856,700,700,743,15,0,0 944,939,771,767,761,15,0,0 722,783,550,618,615,15,0,21
  955,1083,781,798,743,208,0,0 760,913,600,669,561,216,0,0 830,860,586,703,730,0,69,0
  635,716,500,549,760,209,0,0 734,771,600,600,730,162,0,0 734,734,571,600,743,15,0,0
  550,612,450,500,561,15,0,0 680,684,556,540,730,0,0,0 419,552,302,323,760,217,132,43
  393,479,250,299,703,216,0,0 672,707,549,549,730,0,0,3 393,479,250,299,760,9,0,0
  672,683,549,549,730,208,3,3 940,913,768,746,761,15,0,0 737,797,570,640,615,15,0,43
  823,882,672,721,729,15,0,0 795,814,648,649,730,16,0,0 850,848,669,693,743,0,10,0
  731,779,450,500,730,216,0,193 686,726,549,549,730,0,0,0 550,583,450,450,547,0,0,0
  672,773,549,549,730,212,0,0 672,773,549,549,730,212,0,0 600,641,490,473,547,215,0,0
  600,583,472,473,547,212,0,0 637,696,500,500,743,0,0,0 667,773,500,500,730,33,0,0
  578,641,412,447,547,215,0,0 536,638,438,515,736,15,0,0 635,716,500,549,561,209,0,0
  295,373,233,251,730,209,0,0 493,659,371,447,730,209,0,0 643,643,413,489,730,209,0,0
  306,373,250,299,730,0,0,0 1467,1556,1199,1199,929,0,0,0 1345,1413,1099,1099,800,0,0,0
  1155,1298,943,999,800,15,0,0 1169,1284,751,908,730,201,0,0
  917,980,707,799,760,216,0,0 497,686,406,500,760,216,0,0
  1345,1407,838,1088,730,201,0,0 1039,1180,831,900,760,216,0,0
  849,1055,693,799,760,216,0,0 734,795,600,649,929,0,0,0 613,675,500,500,800,15,0,7
  306,373,250,250,929,0,42,41 278,343,199,250,800,0,59,43 856,856,700,700,929,15,0,0
  612,688,500,549,800,15,0,0 795,813,649,649,929,15,0,0 634,712,500,549,800,15,0,0
  795,813,649,649,1041,15,0,0 634,712,500,549,914,15,0,0 795,813,649,649,1115,15,0,0
  634,712,500,549,917,15,0,0 795,813,649,649,1115,15,0,0 634,712,500,549,917,15,0,0
  795,813,649,649,1115,15,0,0 634,712,500,549,917,15,0,0 616,679,500,500,561,15,0,0
  734,795,600,649,1041,0,0,0 613,675,500,500,914,15,0,7 734,795,600,649,1042,0,0,0
  613,675,500,500,915,15,0,7 1100,1100,876,900,914,0,0,0 982,1048,800,800,759,15,0,0
  856,856,697,700,743,15,0,0 635,716,500,549,561,216,0,0 856,856,697,700,929,15,0,0
  635,716,500,549,800,216,0,0 734,795,590,649,929,0,0,31 580,666,450,500,929,0,12,20
  856,856,700,700,743,209,0,0 612,688,500,549,561,209,0,0 856,856,700,700,914,209,0,0
  612,688,500,549,763,209,0,0 672,773,549,549,929,212,0,0 600,583,490,473,800,215,0,11
  278,343,199,250,800,216,54,48 1467,1556,1199,1199,730,0,0,0
  1345,1413,1099,1099,730,0,0,0 1155,1298,943,999,760,15,0,0 856,856,697,700,928,15,0,0
  635,716,500,549,800,216,0,0 1138,1289,930,929,730,15,0,0 683,788,556,598,743,209,0,0
  795,837,649,649,928,0,0,0 634,712,500,549,800,0,0,0 734,795,600,649,1034,0,0,0
  613,675,500,500,983,15,0,34 1100,1100,876,900,928,0,0,0 982,1048,800,800,800,15,0,0
  856,856,700,700,928,37,0,0 672,688,549,549,800,46,0,0 734,795,600,649,930,0,0,0
  613,675,500,500,800,15,0,7 734,795,600,649,923,0,0,0 613,675,500,500,786,15,0,7
  734,734,568,600,930,0,0,0 616,679,500,500,800,15,0,0 734,734,568,600,923,0,0,0
  616,679,500,500,786,15,0,0 306,373,250,250,930,0,141,25 306,343,250,250,800,0,136,39
  306,373,250,250,923,0,26,29 306,343,250,250,786,0,27,28 856,856,700,700,930,15,0,0
  612,688,500,549,800,15,0,0 856,856,700,700,923,15,0,0 612,688,500,549,786,15,0,0
  795,795,625,649,930,0,0,0 412,494,299,350,800,0,43,12 795,795,625,649,923,0,0,0
  412,494,299,350,786,0,0,10 795,813,649,649,930,15,0,0 634,712,500,549,800,15,0,0
  795,813,649,649,923,15,0,0 634,712,500,549,786,15,0,0 734,734,571,600,743,241,0,0
  550,612,450,500,561,241,0,0 672,683,549,549,730,241,3,3 393,479,250,299,703,241,0,0
  627,691,490,519,743,210,0,0 522,608,392,468,561,212,0,0 795,837,649,649,929,0,0,0
  634,712,500,549,929,0,12,0 777,837,635,632,743,209,0,0 838,922,613,753,760,209,0,4
  699,810,544,567,743,15,0,0 622,694,508,567,728,15,0,0 686,726,549,549,730,216,0,0
  550,583,450,450,547,216,0,0 734,795,600,649,928,0,0,0 613,675,500,500,760,15,0,7
  734,734,568,600,730,212,0,0 616,679,500,500,561,212,0,0 856,856,700,700,1041,15,0,0
  612,688,500,549,914,15,0,0 856,856,700,700,1041,15,0,0 612,688,500,549,899,15,0,0
  856,856,700,700,928,15,0,0 612,688,500,549,760,15,0,0 856,856,700,700,1042,15,0,0
  612,688,500,549,915,15,0,0 734,734,549,600,914,0,10,10 592,652,450,500,763,216,0,0
  475,549,314,442,760,209,43,9 843,917,616,750,561,209,0,6 478,557,330,455,703,77,36,0
  278,343,199,250,547,216,34,0 999,1088,798,858,760,15,0,0 999,1088,798,858,561,209,0,0
  734,795,600,649,766,53,14,14 795,795,628,649,766,53,34,34 550,612,450,500,725,208,7,7
  612,672,500,549,730,0,2,0 672,683,549,549,766,53,60,60 550,612,450,500,561,243,0,0
  550,583,450,450,547,243,0,14 639,782,522,580,730,0,0,0 499,615,407,435,561,0,0,0
  734,795,600,649,730,0,0,0 795,813,649,649,730,15,0,0 735,774,601,600,730,0,0,0
  734,734,568,600,822,110,0,0 616,679,500,500,725,208,0,0 550,612,265,334,730,201,57,0
  278,343,199,250,760,216,34,18 812,861,663,697,743,208,0,67
  635,792,500,549,561,216,0,34 795,795,625,649,730,0,0,0 412,494,299,350,561,0,21,0
  734,734,549,600,730,0,10,10 592,652,450,500,547,216,5,4 @374
  367,367,250,271,800,0,0,0 367,367,250,271,36,209,0,0 @37a 500,500,299,299,0,209,0,0
  550,612,450,500,561,15,0,0 550,612,450,494,561,15,0,0 550,612,450,494,561,15,0,0
  337,400,250,299,547,155,0,0 @384 500,442,299,299,800,0,0,4 500,512,299,418,978,0,0,0
  735,798,600,649,800,0,0,0 318,380,250,299,442,0,0,0 863,939,671,761,800,0,24,0
  922,1009,754,815,800,0,19,0 423,564,345,426,800,0,21,0 @38c
  852,908,696,742,800,15,34,0 @38e 942,1020,742,834,800,0,27,12
  828,922,677,754,800,0,34,0 339,390,199,250,978,20,43,43 734,795,600,649,730,0,0,0
  734,795,600,649,730,0,0,0 606,662,495,540,730,0,0,0 735,791,601,646,730,0,0,0
  734,734,568,600,730,0,0,0 686,726,549,549,730,0,0,0 795,837,649,649,730,0,0,0
  856,856,700,700,743,15,0,0 306,373,250,250,730,0,0,0 734,795,590,649,730,0,0,31
  735,774,601,600,730,0,0,0 917,996,749,749,730,0,0,0 795,837,649,649,730,0,0,0
  715,708,568,568,730,0,0,0 856,856,700,700,743,15,0,0 795,837,649,649,730,0,0,0
  734,734,542,600,730,0,0,0 @3a3 680,684,556,540,730,0,0,0 672,683,549,549,730,0,3,3
  734,734,549,600,730,0,10,10 878,903,708,738,730,6,0,0 734,771,600,600,730,0,0,0
  919,890,708,728,730,0,0,0 823,882,672,721,743,0,0,0 306,373,250,250,928,0,21,21
  734,734,549,600,928,0,10,10 660,688,520,553,800,14,0,0 541,557,401,406,800,15,0,8
  634,712,500,549,800,209,0,0 339,390,199,250,800,20,0,0 602,676,492,523,978,15,0,0
  660,688,520,553,561,14,0,0 639,716,517,549,774,209,0,0 592,682,450,500,547,209,0,0
  613,688,500,545,768,15,0,0 541,557,401,427,561,15,0,0 544,591,396,414,760,210,0,0
  634,712,500,549,561,209,0,0 612,688,500,486,768,12,0,0 339,390,199,250,547,20,0,0
  590,711,450,501,547,0,0,2 592,633,450,500,760,0,0,0 637,736,518,550,547,209,0,0
  559,682,450,500,547,0,0,0 558,591,402,400,760,210,0,0 612,688,500,549,561,15,0,0
  759,843,541,689,547,20,0,0 635,716,511,556,562,209,0,0 587,593,433,468,561,210,0,0
  679,779,555,615,547,15,0,0 603,639,355,401,547,20,0,0 602,676,492,523,547,15,0,0
  714,787,583,643,552,209,0,0 578,646,472,518,548,209,0,0 785,829,593,678,655,209,0,0
  859,930,702,760,547,15,0,0 339,390,199,250,774,20,25,25 602,676,492,523,774,15,0,0
  612,688,500,549,800,15,0,0 602,676,492,523,800,15,0,0 859,930,702,760,800,15,0,0 @3d0
  633,672,517,549,769,12,0,5 620,661,492,523,770,12,0,0 850,848,628,671,738,0,0,25
  1054,1102,758,883,800,0,24,27 850,848,628,671,928,0,0,25 660,825,504,674,760,209,0,0
  859,930,702,760,547,15,0,0 664,744,540,608,551,208,0,0 856,856,700,700,743,209,0,0
  612,688,500,549,561,209,0,0 795,795,583,649,730,210,0,0 587,612,450,500,547,210,0,0
  672,684,517,549,730,0,0,0 459,498,363,406,760,209,94,0 687,827,562,631,730,10,0,0
  660,660,476,476,760,0,0,0 866,919,680,723,743,209,0,0 635,672,518,549,729,209,0,0
  980,1093,801,892,730,214,0,0 917,979,749,753,547,209,0,0 759,833,606,632,743,209,0,0
  660,716,500,549,731,209,0,0 792,928,606,632,730,214,0,0 615,744,450,544,576,15,0,0
  734,734,600,600,746,209,0,0 734,734,546,585,699,209,0,0 768,789,548,578,743,0,0,0
  656,671,536,543,561,0,0,0 811,809,629,661,758,15,0,0 612,716,498,520,758,15,0,0
  611,683,417,456,730,209,0,0 537,590,368,395,731,209,0,0 664,744,540,608,551,10,0,0
  635,716,515,555,562,216,0,0 550,612,450,500,561,15,0,0 278,343,199,250,760,216,34,0
  856,856,700,700,743,15,0,0 616,645,397,430,561,15,0,0 616,645,397,430,561,15,0,0
  734,738,544,600,730,0,0,0 635,716,500,549,760,209,0,0 795,795,628,649,743,15,0,0
  917,996,749,749,730,0,0,0 757,814,585,658,547,209,0,0 635,716,511,556,562,209,0,0
  795,795,632,628,743,15,0,0 795,795,628,649,743,15,0,0 795,795,632,628,743,15,0,0
  @2000 550,550,450,450,0,0,0,0 1100,1100,900,900,0,0,0,0 550,550,450,450,0,0,0,0
  1100,1100,900,900,0,0,0,0 367,367,296,296,0,0,0,0 275,275,225,225,0,0,0,0
  184,184,149,149,0,0,0,0 637,696,500,500,0,0,0,0 318,380,250,250,0,0,0,0
  221,221,179,179,0,0,0,0 100,100,75,75,0,0,0,0 @2010 367,416,299,299,359,0,0,0 @2012
  637,696,500,500,337,0,2,0 612,612,450,450,337,0,0,0 1100,1100,900,900,337,0,0,0
  1100,1100,900,900,337,0,0,0 500,548,371,447,765,236,0,0 608,608,450,450,0,250,16,16
  318,380,199,250,730,0,0,0 318,380,199,250,730,0,0,0 318,380,199,250,189,155,0,0
  318,380,199,250,730,0,0,0 519,658,299,450,730,0,0,0 519,658,299,450,730,0,0,0
  519,658,299,450,189,155,0,0 519,658,299,450,730,0,0,0 612,612,450,450,730,97,0,0
  612,612,450,450,730,97,0,0 590,640,315,315,547,0,0,0 @2026
  1100,1100,900,900,189,0,0,0 @202f 221,221,179,179,0,0,0,0
  1342,1440,900,900,743,15,0,0 @2032 228,264,168,215,730,0,0,0
  390,527,318,402,730,0,0,0 521,630,318,431,730,0,45,39 @2039 400,413,299,299,520,0,0,0
  400,413,299,299,520,0,0,0 @203c 550,665,436,543,730,0,0,0 @203e
  500,500,299,299,792,0,64,64 @2044 184,184,150,150,743,15,204,200 @205e
  318,380,250,299,725,0,0,0 @20a0 877,930,500,500,730,0,0,0 795,795,572,626,778,56,0,0
  795,795,572,626,743,14,0,0 637,696,500,500,730,0,0,0 637,696,500,500,743,0,0,0
  975,1042,749,800,657,98,0,0 795,795,572,626,730,0,0,0 1273,1518,984,984,730,15,0,0
  1281,1348,966,1084,730,15,0,0 1039,1104,849,849,730,0,0,0 935,973,705,795,730,15,0,0
  637,696,461,461,760,183,0,0 637,696,500,500,743,15,20,0 734,795,572,626,730,0,0,0
  672,696,549,549,730,0,0,0 1273,1392,900,977,807,224,0,0 637,696,468,500,743,208,0,0
  734,734,572,600,730,0,0,0 856,856,572,626,809,104,0,0 734,795,572,626,730,0,0,1
  774,860,500,600,743,15,0,0 795,795,572,626,766,147,0,0 @2105
  1019,1092,796,796,752,24,0,0 @2113 414,538,290,424,743,15,14,0 @2116
  1181,1227,936,1003,730,0,0,0 1000,1000,663,663,726,8,0,0 @2122
  1100,1100,900,900,730,0,0,0 @2126 845,851,687,691,743,0,0,0 @212e
  855,855,540,540,647,17,0,0 @214e 539,551,440,450,547,0,0,0 @2190
  1100,1100,754,754,540,0,0,0 838,838,450,450,733,30,0,0 1100,1100,754,754,540,0,0,0
  838,838,450,450,730,30,0,0 1100,1100,754,754,540,0,0,0 838,838,450,450,733,30,0,0
  @21a8 838,838,450,450,733,90,0,0 @21d4 1100,1100,754,754,540,0,0,0 @2202
  544,544,444,444,722,15,0,0 @2206 673,697,550,550,720,0,3,3 @220f
  906,906,681,708,720,223,0,0 @2211 785,785,606,641,720,223,0,0
  838,838,525,525,388,0,0,0 @2215 337,366,150,150,730,93,204,185 @2219
  626,380,250,250,458,0,0,0 638,667,493,493,837,21,0,3 @221e 834,834,641,641,506,0,0,0
  1077,1077,754,754,693,0,0,0 @2229 791,813,646,649,580,1,0,0 @222b
  521,610,246,246,757,228,63,69 @2248 838,838,493,493,527,0,0,0 @2260
  838,838,493,493,646,5,0,0 838,838,525,525,589,0,0,0 1100,1100,754,754,695,69,0,0
  @2264 838,838,493,493,634,0,0,0 838,838,493,493,634,0,0,0 @25a0
  945,945,543,543,643,124,0,0 945,945,543,543,643,124,0,0 @25aa
  678,678,319,319,509,0,0,0 678,678,319,319,509,0,0,0 1100,1100,850,850,445,0,0,0 @25b2
  1089,1089,692,692,643,124,0,0 @25ba 1089,1089,692,692,584,14,0,0 @25bc
  1089,1089,692,692,643,124,0,0 @25c4 1089,1089,692,692,584,14,0,0 @25ca
  544,544,444,444,808,233,0,0 873,873,543,543,646,126,0,0 873,873,534,534,645,125,0,0
  @25cf 873,873,543,543,641,124,0,0 873,873,543,543,641,124,0,0
  873,873,543,543,641,124,0,0 873,873,543,543,641,124,0,0 873,873,543,543,641,124,0,0
  873,873,543,543,641,124,0,0 873,873,543,543,641,124,0,0 665,665,474,474,646,126,0,0
  665,665,474,474,646,126,0,0 792,841,543,543,770,10,0,0 971,971,543,543,770,250,0,0
  @25e6 590,640,319,319,547,0,0,0`;
const GLYPHS = new Map();
{
  let cp = 0;
  for (const tok of GLYPH_TABLE.trim().split(/\s+/))
    if (tok[0] === "@") cp = parseInt(tok.slice(1), 16);
    else GLYPHS.set(String.fromCodePoint(cp++), tok.split(",").map(Number));
}

// a text's glyph cells, relative to its anchor. A run of advances a_k starts at
// -share * sum(a), so glyph i spans [(1 - share) * P_i - share * S_i, (1 - share) *
// P_i+1 - share * S_i+1] (P: the sum of the advances before, S: from i on). Each advance
// lies between its narrowest and widest, so each cell takes the extreme of each sum: it
// spans every place its glyph can be drawn, ink overhang included. A heavy text (weight
// over 500, which font matching sets in the bold face, or a variable face between) takes
// the wider and the narrower of the regular and bold advances. Every character is in
// GLYPHS (the caller refuses the rest).
const glyphCells = (s, px, heavy, share) => {
  const rows = [...s].map((ch) => [ch, GLYPHS.get(ch)]);
  const wide = (r) => (heavy ? Math.max(r[0], r[1]) : r[0]);
  const narrow = (r) => (heavy ? Math.min(r[2], r[3]) : r[2]);
  // suffix sums of the widest and narrowest advances
  const sufWide = new Array(rows.length + 1).fill(0);
  const sufNarrow = new Array(rows.length + 1).fill(0);
  for (let i = rows.length - 1; i >= 0; i--) {
    sufWide[i] = sufWide[i + 1] + wide(rows[i][1]);
    sufNarrow[i] = sufNarrow[i + 1] + narrow(rows[i][1]);
  }
  const k = px / 1000;
  const cells = [];
  let preWide = 0;
  let preNarrow = 0;
  rows.forEach(([ch, r], i) => {
    const x0 = (1 - share) * preNarrow - share * sufWide[i] - r[6];
    preWide += wide(r);
    preNarrow += narrow(r);
    const x1 = (1 - share) * preWide - share * sufNarrow[i + 1] + r[7];
    if (/\S/u.test(ch)) cells.push([x0 * k, -r[4] * k, x1 * k, r[5] * k]);
  });
  return cells;
};

// ---- geometry ---------------------------------------------------------------------------------

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
const toBox = ([x, y], b) =>
  Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
const union = (boxes) => {
  const u = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    if (b[0] < u[0]) u[0] = b[0];
    if (b[1] < u[1]) u[1] = b[1];
    if (b[2] > u[2]) u[2] = b[2];
    if (b[3] > u[3]) u[3] = b[3];
  }
  return u;
};

// is the point inside a (rounded) rect, boundary included?
const inRect = (g, x, y) => {
  const [x0, y0, x1, y1] = g.box;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (!(g.rx > 0)) return true;
  const ex = Math.max(0, Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - g.rx));
  const ey = Math.max(0, Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - g.ry));
  return (ex / g.rx) ** 2 + (ey / g.ry) ** 2 <= 1;
};
// a rect is convex: it holds a box when it holds the box's corners
const rectHolds = (g, b) => corners(b).every(([x, y]) => inRect(g, x, y));
// does a disc paint inside the box? (here and below: over a positive area; a shape that
// only touches the box does not meet it)
const discMeets = (c, r, b) => toBox(c, b) < r;
// does the fill of a (rounded) rect meet the box? its cross of straight edges, or a corner
const rectMeets = (g, b) => {
  if (!overlaps(g.box, b)) return false;
  if (!(g.rx > 0)) return true;
  const [x0, y0, x1, y1] = g.box;
  const { rx, ry } = g;
  if (overlaps([x0 + rx, y0, x1 - rx, y1], b)) return true;
  if (overlaps([x0, y0 + ry, x1, y1 - ry], b)) return true;
  // a corner quarter-ellipse: the box's point nearest its centre is inside it
  return [
    [x0 + rx, y0 + ry],
    [x1 - rx, y0 + ry],
    [x0 + rx, y1 - ry],
    [x1 - rx, y1 - ry],
  ].some(
    ([cx, cy]) =>
      ((Math.min(Math.max(cx, b[0]), b[2]) - cx) / rx) ** 2 +
        ((Math.min(Math.max(cy, b[1]), b[3]) - cy) / ry) ** 2 <
      1,
  );
};
// does a straight-edged fill (every subpath closed) paint inside the box? Each subpath
// clipped to the box (Sutherland-Hodgman) keeps some area; a hole counts as paint
const polyMeets = (g, b) =>
  g.subpaths.some(({ pts }) => {
    let poly = pts;
    for (const [axis, bound, keep] of [
      [0, b[0], 1],
      [0, b[2], -1],
      [1, b[1], 1],
      [1, b[3], -1],
    ]) {
      const next = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        const pin = (p[axis] - bound) * keep >= 0;
        const qin = (q[axis] - bound) * keep >= 0;
        if (pin) next.push(p);
        if (pin !== qin) {
          const t = (bound - p[axis]) / (q[axis] - p[axis]);
          next.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        }
      }
      poly = next;
      if (poly.length < 3) return false;
    }
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      area += x0 * y1 - x1 * y0;
    }
    return Math.abs(area) > 1e-9;
  });
// does the band of half width d around segment a-b, extended by e0 before a and e1
// after b (a butt or square cap), meet the box? (separating axes; touching is apart)
const bandMeets = (a, b, d, e0, e1, box) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!L) return false;
  const ux = (b[0] - a[0]) / L;
  const uy = (b[1] - a[1]) / L;
  const ends = [
    [a[0] - ux * e0, a[1] - uy * e0],
    [b[0] + ux * e1, b[1] + uy * e1],
  ];
  const band = ends.flatMap(([x, y]) => [
    [x - uy * d, y + ux * d],
    [x + uy * d, y - ux * d],
  ]);
  const B = corners(box);
  for (const [ax, ay] of [
    [1, 0],
    [0, 1],
    [ux, uy],
    [-uy, ux],
  ]) {
    let pl = Infinity;
    let ph = -Infinity;
    let bl = Infinity;
    let bh = -Infinity;
    for (const [x, y] of band) {
      const v = x * ax + y * ay;
      pl = Math.min(pl, v);
      ph = Math.max(ph, v);
    }
    for (const [x, y] of B) {
      const v = x * ax + y * ay;
      bl = Math.min(bl, v);
      bh = Math.max(bh, v);
    }
    if (ph <= bl || bh <= pl) return false;
  }
  return true;
};

// path data of straight segments → { subpaths: [{ pts, closed }] }, else { bad }
const parsePath = (d) => {
  const toks = d.match(new RegExp(`${NUMBER}|[A-Za-z]`, "g")) ?? [];
  if (toks.length > LIMITS.numbers) return { tooLarge: toks.length };
  if (d.replace(new RegExp(`${NUMBER}|[A-Za-z]|[\\s,]`, "g"), ""))
    return { bad: `d="${d}"` };
  const subpaths = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let cmd = null;
  for (let i = 0; i < toks.length;) {
    if (/^[A-Za-z]$/.test(toks[i])) {
      cmd = toks[i++];
      if (!SUBSET.pathCommands.has(cmd)) return { bad: `path command ${cmd}` };
      if (/z/i.test(cmd)) {
        if (cur) {
          cur.closed = true;
          [x, y] = cur.pts[0];
          cur = null;
        }
        continue;
      }
    } else if (!cmd || /z/i.test(cmd)) return { bad: `d="${d}"` };
    const rel = cmd === cmd.toLowerCase();
    const n = /[hv]/i.test(cmd) ? 1 : 2;
    if (
      toks.length - i < n ||
      toks.slice(i, i + n).some((t) => !NUMBER_RE.test(t))
    )
      return { bad: `d="${d}"` };
    const args = toks.slice(i, i + n).map(Number);
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
// do segments a-b and c-d meet (touching included)?
const segmentsMeet = (a, b, c, d) => {
  const orient = (p, q, r) => {
    const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return Math.abs(v) < 1e-9 ? 0 : Math.sign(v);
  };
  const onSegment = (p, q, r) =>
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
};
// does a fill outline (every subpath closed) cross or touch itself? Segments that follow
// each other on one subpath may share their vertex
const selfIntersects = (subpaths) => {
  const segs = [];
  subpaths.forEach(({ pts: all }, k) => {
    // repeated vertices (a closing point on the start) make no segment
    const pts = all.filter(
      (p, i) =>
        i === 0 ||
        (i === all.length - 1 && p[0] === all[0][0] && p[1] === all[0][1]
          ? false
          : p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]),
    );
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (a[0] !== b[0] || a[1] !== b[1]) segs.push({ a, b, k, i, n });
    }
  });
  for (let x = 0; x < segs.length; x++)
    for (let y = x + 1; y < segs.length; y++) {
      const s = segs[x];
      const t = segs[y];
      const next =
        s.k === t.k && ((s.i + 1) % s.n === t.i || (t.i + 1) % t.n === s.i);
      if (!next && segmentsMeet(s.a, s.b, t.a, t.b)) return true;
    }
  return false;
};
// does a subpath enclose any area? three distinct vertices not on one line
const hasArea = (pts) => {
  const [a] = pts;
  const b = pts.find((p) => p[0] !== a[0] || p[1] !== a[1]);
  return (
    b !== undefined &&
    pts.some(
      (p) =>
        Math.abs(
          (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]),
        ) > 1e-9,
    )
  );
};

// ---- SVG → small element tree ------------------------------------------------------------

// the tree, the <style> sheets, and the reasons it cannot be audited; parsing stops at
// the first limit it passes
function parseSvg(src, issue) {
  const root = {
    tag: "#root",
    a: Object.create(null),
    kids: [],
    parent: null,
    depth: 0,
  };
  const styles = [];
  const decode = (s) =>
    s.replace(/&(#[0-9]+;|#x[0-9a-fA-F]+;|[A-Za-z][\w.-]*;)?/g, (all, body) => {
      if (!body) {
        issue("invalid entity: a bare &");
        return all;
      }
      if (body[0] === "#") {
        const cp =
          body[1] === "x"
            ? parseInt(body.slice(2, -1), 16)
            : parseInt(body.slice(1, -1), 10);
        const xmlChar =
          cp === 9 ||
          cp === 10 ||
          cp === 13 ||
          (cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff));
        if (!xmlChar) {
          issue(`invalid entity ${all}`);
          return "";
        }
        return String.fromCodePoint(cp);
      }
      const name = body.slice(0, -1);
      if (Object.hasOwn(SUBSET.entities, name)) return SUBSET.entities[name];
      issue(`unsupported entity ${all}`);
      return all;
    });
  let cur = root;
  let last = 0;
  let count = 0;
  const addText = (to) => {
    const t = src.slice(last, to);
    if (/</.test(t)) issue('malformed XML: a "<" that opens no tag');
    if (t && cur !== root) cur.kids.push({ text: decode(t), parent: cur });
  };
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    addText(m.index);
    last = re.lastIndex;
    if (!m[2]) {
      if (m[0].startsWith("<![CDATA[")) issue("unsupported CDATA section");
      else if (m[0].startsWith("<!DOCTYPE")) issue("unsupported DOCTYPE");
      else if (
        m[0].startsWith("<?") &&
        !(/^<\?xml\s/.test(m[0]) && !src.slice(0, m.index).trim())
      )
        issue(`unsupported processing instruction ${m[0].slice(0, 20)}`);
      continue;
    }
    const name = m[2];
    if (m[1]) {
      if (cur.tag !== name) {
        issue(`malformed XML: </${name}> does not close <${cur.tag}>`);
        return { root, styles, stop: true };
      }
      cur = cur.parent;
      continue;
    }
    if (++count > LIMITS.elements) {
      issue(`too large: more than ${LIMITS.elements} elements`);
      return { root, styles, stop: true };
    }
    // attributes in a map with no prototype, so any name is an own key or absent
    const a = Object.create(null);
    const rest = m[3].replace(
      /([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      (all, k, v1, v2) => {
        if (Object.hasOwn(a, k))
          issue(`malformed XML: ${k} twice on <${name}>`);
        // XML attribute-value normalization: each literal tab or line break is a space
        a[k] = decode((v1 ?? v2).replace(/\r\n?|[\t\n]/g, " "));
        return "";
      },
    );
    if (rest.trim()) issue(`malformed XML: attributes of <${name}>`);
    const el = { tag: name, a, kids: [], parent: cur, depth: cur.depth + 1 };
    if (el.depth > LIMITS.depth) {
      issue(`too large: nesting deeper than ${LIMITS.depth}`);
      return { root, styles, stop: true };
    }
    cur.kids.push(el);
    if (m[4]) continue;
    if (name === "style") {
      // raw text up to </style>: CSS may hold `>` and quotes the tag pattern would misread
      const tail = /<\/style\s*>/.exec(src.slice(last));
      if (!tail) {
        issue("malformed XML: <style> is not closed");
        return { root, styles, stop: true };
      }
      const css = src.slice(last, last + tail.index);
      if (css.includes("<![CDATA[")) issue("unsupported CDATA section");
      // character data: its entities are decoded before the CSS is read
      styles.push(decode(css));
      last = re.lastIndex = last + tail.index + tail[0].length;
      continue;
    }
    cur = el;
  }
  addText(src.length);
  if (cur !== root) issue(`malformed XML: <${cur.tag}> is not closed`);
  return { root, styles, stop: cur !== root };
}

// ---- the stylesheet -----------------------------------------------------------------------

// balanced {…} starting at the `{` at index i → index of its `}`, or -1
const closeBrace = (s, i) => {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return j;
  }
  return -1;
};
// CSS declarations "k: v; k: v" → [[k, v, text]], or a reason they cannot be read
const declarations = (body) => {
  if (body.includes("/*")) return { bad: "CSS comment" };
  if (/!\s*important/i.test(body)) return { bad: "CSS !important" };
  const out = [];
  for (const part of body.split(";")) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    if (i < 0) return { bad: `CSS declaration "${part.trim()}"` };
    out.push([
      part.slice(0, i).trim().toLowerCase(),
      part.slice(i + 1).trim(),
      part.trim(),
    ]);
  }
  return { decls: out };
};
const SELECTOR = /^([a-z]+)\[\s*([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\]$/;
const DARK_MEDIA = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/;

// the dark rules of one <style>: [{ tag, attr, value, props }]; what is not in the subset
// is reported and not applied
function parseDarkSheet(css, unsupported) {
  const rules = [];
  if (css.includes("/*")) {
    unsupported("CSS comment in <style>");
    return rules;
  }
  if (/!\s*important/i.test(css)) {
    unsupported("CSS !important");
    return rules;
  }
  const snippet = (s) => s.trim().replace(/\s+/g, " ").slice(0, 60);
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    const head = DARK_MEDIA.exec(css.slice(i));
    const end = head ? closeBrace(css, i + head[0].length - 1) : -1;
    if (!head || end < 0) {
      const brace = css.indexOf("{", i);
      const prelude = snippet(css.slice(i, brace < 0 ? css.length : brace));
      unsupported(
        `CSS "${prelude}": only @media (prefers-color-scheme: dark) blocks are read`,
      );
      return rules;
    }
    const body = css.slice(i + head[0].length, end);
    i = end + 1;
    let j = 0;
    while (j < body.length) {
      while (j < body.length && /\s/.test(body[j])) j++;
      if (j >= body.length) break;
      const open = body.indexOf("{", j);
      const close = open < 0 ? -1 : body.indexOf("}", open);
      if (close < 0 || body.slice(open + 1, close).includes("{")) {
        unsupported(`CSS "${snippet(body.slice(j))}" in the dark rules`);
        return rules;
      }
      const sels = body.slice(j, open).split(",");
      const d = declarations(body.slice(open + 1, close));
      j = close + 1;
      if (d.bad) {
        unsupported(`${d.bad} in the dark rules`);
        continue;
      }
      const props = Object.create(null);
      for (const [k, v, text] of d.decls) {
        if (Object.hasOwn(SUBSET.darkProps, k) && SUBSET.darkProps[k](v))
          props[k] = v;
        else unsupported(`CSS declaration "${text}" in the dark rules`);
      }
      for (const sel of sels) {
        const s = SELECTOR.exec(sel.trim());
        if (s && SUBSET.darkTags.has(s[1]) && SUBSET.darkAttrs.has(s[2]))
          rules.push({ tag: s[1], attr: s[2], value: s[3] ?? s[4], props });
        else unsupported(`selector "${sel.trim()}"`);
      }
    }
  }
  return rules;
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
  // an issue about the input itself, reported once however often it is met
  const seen = new Set();
  const once = (msg) => {
    if (!seen.has(msg)) out.push(msg);
    seen.add(msg);
  };
  const issue = (what) => once(`${what}: the audit cannot verify it`);
  const unsupported = (what) => issue(`unsupported ${what}`);

  if (typeof svg !== "string") {
    issue("not an SVG: the input is not a string");
    return done();
  }
  if (svg.length > LIMITS.bytes) {
    issue(`too large: more than ${LIMITS.bytes} characters`);
    return done();
  }
  const { root, styles, stop } = parseSvg(svg, issue);
  if (stop) return done();
  const tops = root.kids.filter((k) => k.tag);
  const svgEl = tops[0]?.tag === "svg" ? tops[0] : null;
  if (!svgEl) {
    out.push("not an SVG: no <svg> root element");
    return done();
  }
  if (tops.length > 1) unsupported(`<${tops[1].tag}> after the root <svg>`);

  // ---- the drawn tree in paint order; every element, attribute and value in the subset
  const drawn = [];
  const stack = [svgEl];
  while (stack.length) {
    const el = stack.pop();
    const allowed = Object.hasOwn(SUBSET.elements, el.tag)
      ? SUBSET.elements[el.tag]
      : null;
    if (!allowed) {
      unsupported(`<${el.tag}>`);
      continue;
    }
    if (!SUBSET.parents[el.tag].includes(el.parent.tag)) {
      unsupported(`<${el.tag}> inside <${el.parent.tag}>`);
      continue;
    }
    for (const [k, v] of Object.entries(el.a)) {
      if (!Object.hasOwn(allowed, k))
        unsupported(`attribute ${k} on <${el.tag}>`);
      else if (!allowed[k](v)) unsupported(`${k}="${v}" on <${el.tag}>`);
    }
    // accumulated translate()
    el.dx = el.parent.dx ?? 0;
    el.dy = el.parent.dy ?? 0;
    if (el.tag === "g" && el.a.transform && isTranslateList(el.a.transform))
      for (const t of el.a.transform.matchAll(/\(([^)]*)\)/g)) {
        const [x, y = "0"] = t[1].trim().split(/[\s,]+/);
        el.dx += +x;
        el.dy += +y;
      }
    if (SHAPES.has(el.tag) || el.tag === "text") {
      el.ord = drawn.length;
      drawn.push(el);
    }
    if (el.tag !== "style")
      for (let i = el.kids.length - 1; i >= 0; i--)
        if (el.kids[i].tag) stack.push(el.kids[i]);
  }
  // the root's style attribute
  if (svgEl.a.style !== undefined) {
    const d = declarations(svgEl.a.style);
    if (d.bad) unsupported(`${d.bad} in the style attribute of <svg>`);
    else
      for (const [k, v, text] of d.decls)
        if (!(Object.hasOwn(SUBSET.rootStyle, k) && SUBSET.rootStyle[k](v)))
          unsupported(
            `CSS declaration "${text}" in the style attribute of <svg>`,
          );
  }
  const dark = styles.flatMap((css) => parseDarkSheet(css, unsupported));

  // the canvas: numeric width and height equal to the viewBox, so lengths are px
  const vb = (svgEl.a.viewBox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !isViewBox(svgEl.a.viewBox ?? "") ||
    !isSize(svgEl.a.width ?? "") ||
    !isSize(svgEl.a.height ?? "")
  ) {
    unsupported("<svg> without a numeric width, height and viewBox");
    return done();
  }
  const W = +svgEl.a.width;
  const H = +svgEl.a.height;
  if (W !== vb[2] || H !== vb[3])
    unsupported(`viewBox scaling (${vb[2]}x${vb[3]} drawn at ${W}x${H})`);
  const [originX, originY] = vb;

  // ---- computed values

  // a property in a theme: the last dark rule selecting the element, else its attribute,
  // else (font-family) the root's, else the initial value
  const prop = (el, name, theme) => {
    if (theme === "dark")
      for (let i = dark.length - 1; i >= 0; i--) {
        const r = dark[i];
        if (r.tag === el.tag && el.a[r.attr] === r.value && name in r.props)
          return r.props[name];
      }
    if (el.a[name] !== undefined) return el.a[name];
    if (name === "font-family") return svgEl.a[name];
    return INITIAL[name];
  };
  const memo = (el, key, f) => {
    el.memo ??= new Map();
    if (!el.memo.has(key)) el.memo.set(key, f());
    return el.memo.get(key);
  };
  const num = (el, name) => (el.a[name] === undefined ? 0 : +el.a[name]);
  // effective { raw, color, alpha } of a channel in a theme; alpha 0 paints nothing
  const paintOf = (el, ch, theme) =>
    memo(el, `${ch} ${theme}`, () => {
      const raw = prop(el, ch, theme);
      const color = parseColor(raw);
      let alpha = color ? color.a : 0;
      if (ch === "stroke" && !(+prop(el, "stroke-width", theme) > 0)) alpha = 0;
      return { raw, color, alpha };
    });
  const half = (e, theme) => +prop(e, "stroke-width", theme) / 2;

  // a shape's geometry with the translates applied: { kind, box, area, ... }; box is null
  // when the shape draws nothing
  const geom = (e) =>
    memo(e, "geom", () => {
      const dx = e.dx;
      const dy = e.dy;
      if (e.tag === "rect") {
        const x = num(e, "x") + dx;
        const y = num(e, "y") + dy;
        const w = num(e, "width");
        const h = num(e, "height");
        if (!(w > 0 && h > 0)) return { kind: "rect", box: null, w: 0, h: 0 };
        const r = num(e, "rx");
        return {
          kind: "rect",
          box: [x, y, x + w, y + h],
          w,
          h,
          rx: Math.min(r, w / 2),
          ry: Math.min(r, h / 2),
          area: true,
        };
      }
      if (e.tag === "circle") {
        const c = [num(e, "cx") + dx, num(e, "cy") + dy];
        const r = num(e, "r");
        if (!(r > 0)) return { kind: "circle", box: null };
        return {
          kind: "circle",
          box: [c[0] - r, c[1] - r, c[0] + r, c[1] + r],
          c,
          r,
          area: true,
        };
      }
      let subpaths;
      if (e.tag === "line")
        subpaths = [
          {
            pts: [
              [num(e, "x1"), num(e, "y1")],
              [num(e, "x2"), num(e, "y2")],
            ],
            closed: false,
          },
        ];
      else if (e.tag === "path") {
        const p = parsePath(e.a.d ?? "");
        if (p.tooLarge)
          issue(
            `too large: ${p.tooLarge} path tokens (limit ${LIMITS.numbers})`,
          );
        else if (p.bad) unsupported(`${p.bad} on <path>`);
        if (!p.subpaths) return { kind: "poly", box: null };
        subpaths = p.subpaths;
      } else {
        const n = (e.a.points ?? "")
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean);
        if (n.length > LIMITS.numbers) {
          issue(
            `too large: ${n.length} numbers in points (limit ${LIMITS.numbers})`,
          );
          return { kind: "poly", box: null };
        }
        if (n.length % 2 || !n.every((t) => NUMBER_RE.test(t))) {
          unsupported(`points="${e.a.points}" on <polyline>`);
          return { kind: "poly", box: null };
        }
        const pts = [];
        for (let i = 0; i < n.length; i += 2) pts.push([+n[i], +n[i + 1]]);
        subpaths = [{ pts, closed: false }];
      }
      subpaths = subpaths
        .map((s) => ({ ...s, pts: s.pts.map(([x, y]) => [x + dx, y + dy]) }))
        .filter((s) => s.pts.length);
      if (!subpaths.length) return { kind: "poly", box: null };
      return {
        kind: "poly",
        box: union(
          subpaths.flatMap((s) => s.pts.map(([x, y]) => [x, y, x, y])),
        ),
        subpaths,
        area: subpaths.some((s) => hasArea(s.pts)),
      };
    });
  // does the shape's fill paint inside box b?
  const fillMeets = (e, b) => {
    const g = geom(e);
    if (!g.box || !g.area) return false;
    if (g.kind === "rect") return rectMeets(g, b);
    if (g.kind === "circle") return discMeets(g.c, g.r, b);
    return polyMeets(g, b);
  };
  // the stroke's shape: its caps and joins, and how far it reaches past its geometry
  const strokeForm = (e, theme) =>
    memo(e, `form ${theme}`, () => {
      const d = half(e, theme);
      const cap = prop(e, "stroke-linecap", theme).trim();
      const join = prop(e, "stroke-linejoin", theme).trim();
      const joinReach = join === "miter" ? MITER_LIMIT * d : d;
      const capReach = cap === "square" ? Math.SQRT2 * d : d;
      return { d, cap, joinReach, reach: Math.max(d, joinReach, capReach) };
    });
  // the box a channel can paint in, or null
  const reachBox = (e, ch, theme) =>
    memo(e, `reach ${ch} ${theme}`, () => {
      const g = geom(e);
      if (!g.box || paintOf(e, ch, theme).alpha === 0) return null;
      if (ch === "fill") return g.area ? g.box : null;
      return grow(
        g.box,
        g.kind === "poly" ? strokeForm(e, theme).reach : half(e, theme),
      );
    });
  // does the shape's stroke paint inside box b? Exact for rect and circle bands and for
  // straight segments with butt, square or round caps; a join counts as a disc of its
  // largest reach around the vertex
  const strokeMeets = (e, b, theme) => {
    const r = reachBox(e, "stroke", theme);
    if (!r || !overlaps(r, b)) return false;
    const g = geom(e);
    const d = half(e, theme);
    if (g.kind === "rect") {
      const inner = [g.box[0] + d, g.box[1] + d, g.box[2] - d, g.box[3] - d];
      return !(
        inner[0] < inner[2] &&
        inner[1] < inner[3] &&
        rectHolds(
          { box: inner, rx: Math.max(0, g.rx - d), ry: Math.max(0, g.ry - d) },
          b,
        )
      );
    }
    if (g.kind === "circle")
      return (
        discMeets(g.c, g.r + d, b) &&
        !(
          g.r > d &&
          corners(b).every(
            (p) => Math.hypot(p[0] - g.c[0], p[1] - g.c[1]) <= g.r - d,
          )
        )
      );
    const { cap, joinReach } = strokeForm(e, theme);
    for (const { pts, closed } of g.subpaths) {
      const n = pts.length;
      const moves = pts.some((p) => p[0] !== pts[0][0] || p[1] !== pts[0][1]);
      if (!moves) {
        // a zero-length subpath: a dot for a round or square cap
        if (cap !== "butt" && discMeets(pts[0], Math.SQRT2 * d, b)) return true;
        continue;
      }
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i];
        const c = pts[(i + 1) % n];
        const sq = (end) => (!closed && end && cap === "square" ? d : 0);
        if (bandMeets(a, c, d, sq(i === 0), sq(i === segs - 1), b)) return true;
      }
      for (let i = 0; i < n; i++) {
        const end = !closed && (i === 0 || i === n - 1);
        const radius = end ? (cap === "round" ? d : 0) : joinReach;
        if (radius > 0 && discMeets(pts[i], radius, b)) return true;
      }
    }
    return false;
  };
  const channelMeets = (e, ch, b, theme) =>
    ch === "fill"
      ? paintOf(e, "fill", theme).alpha > 0 && fillMeets(e, b)
      : strokeMeets(e, b, theme);

  const isCanvas = (e) => {
    if (e.tag !== "rect") return false;
    const g = geom(e);
    return (
      g.box !== null &&
      Math.abs(g.box[0] - originX) < 0.5 &&
      Math.abs(g.box[1] - originY) < 0.5 &&
      Math.abs(g.w - W) < 0.5 &&
      Math.abs(g.h - H) < 0.5
    );
  };
  // a gridline or rule: a line, path or polyline stroked in the grid colour
  const isGridHairline = (e) => {
    if (!HAIRLINES.has(e.tag)) return false;
    const c = paintOf(e, "stroke", "light").color;
    return c !== null && c.rgb.every((v, i) => v === grid.rgb[i]);
  };
  const shapes = drawn.filter((e) => e.tag !== "text");
  // a fill whose outline crosses itself: which parts are inside is not modelled
  for (const e of shapes)
    if (
      geom(e).kind === "poly" &&
      geom(e).area &&
      SHAPES.get(e.tag).includes("fill") &&
      THEMES.some((t) => paintOf(e, "fill", t).alpha > 0) &&
      selfIntersects(geom(e).subpaths)
    )
      unsupported(`self-intersecting fill on <${e.tag}>`);
  const texts = drawn.filter((e) => e.tag === "text");
  for (const theme of THEMES)
    if (!shapes.some((e) => isCanvas(e) && paintOf(e, "fill", theme).alpha > 0))
      notes.add(FALLBACK_NOTE);

  // ---- backdrops: the rects painted before an element, over the region it paints
  // (region: { box, meets(b) }). Each cell of the plane cut by those rects' edges (and
  // their corner radii) inside the region is composited on its own; a cell a rounded
  // corner crosses counts with and without that rect.
  const rectFills = Object.fromEntries(
    THEMES.map((t) => [
      t,
      shapes.filter(
        (e) =>
          e.tag === "rect" && geom(e).box && paintOf(e, "fill", t).alpha > 0,
      ),
    ]),
  );
  const otherFills = Object.fromEntries(
    THEMES.map((t) => [
      t,
      shapes.filter(
        (e) =>
          e.tag !== "rect" &&
          SHAPES.get(e.tag).includes("fill") &&
          geom(e).area &&
          paintOf(e, "fill", t).alpha > 0,
      ),
    ]),
  );
  // strokes: the earlier strokes under the region (a grid hairline is decoration), each
  // composited in paint order both ways, over the cells it reaches
  const backdrop = (theme, ord, region, strokes = []) => {
    const rs = [];
    for (const r of rectFills[theme]) {
      if (r.ord >= ord) break;
      if (overlaps(geom(r).box, region.box) && region.meets(geom(r).box))
        rs.push(r);
    }
    // the layers in paint order: an element's fill, then its stroke
    const order = [
      ...rs.map((e) => ({ e, ch: "fill", at: e.ord })),
      ...strokes.map((e) => ({ e, ch: "stroke", at: e.ord + 0.5 })),
    ].sort((a, b) => a.at - b.at);
    const [bx0, by0, bx1, by1] = region.box;
    const xs = new Set([bx0, bx1]);
    const ys = new Set([by0, by1]);
    for (const r of rs) {
      const { box, rx, ry } = geom(r);
      for (const x of [box[0], box[2], box[0] + rx, box[2] - rx])
        if (x > bx0 && x < bx1) xs.add(x);
      for (const y of [box[1], box[3], box[1] + ry, box[3] - ry])
        if (y > by0 && y < by1) ys.add(y);
    }
    const X = [...xs].sort((a, b) => a - b);
    const Y = [...ys].sort((a, b) => a - b);
    if ((X.length - 1) * (Y.length - 1) > LIMITS.regions) return null;
    const colours = new Map();
    for (let i = 0; i + 1 < X.length; i++)
      for (let j = 0; j + 1 < Y.length; j++) {
        const cell = [X[i], Y[j], X[i + 1], Y[j + 1]];
        if (!region.meets(cell)) continue;
        let layers = [FALLBACK_PAGE[theme]];
        for (const { e, ch } of order) {
          const g = geom(e);
          const c = paintOf(e, ch, theme).color;
          if (ch === "fill" && rectHolds(g, cell))
            layers = layers.map((l) => over(c, l));
          else if (
            ch === "fill" ? rectMeets(g, cell) : strokeMeets(e, cell, theme)
          )
            layers = [...layers, ...layers.map((l) => over(c, l))];
          if (layers.length > LIMITS.layers) return null;
        }
        for (const l of layers)
          colours.set(l.map((v) => v.toFixed(3)).join(), l);
        if (colours.size > LIMITS.layers) return null;
      }
    return [...colours.values()];
  };
  // both ways: each backdrop with and without a layer of colour c on top
  const withLayer = (bgs, c) => {
    const more = new Map(
      bgs.map((l) => [l.map((v) => v.toFixed(3)).join(), l]),
    );
    for (const l of bgs) {
      const t = over(c, l);
      more.set(t.map((v) => v.toFixed(3)).join(), t);
    }
    return more.size > LIMITS.layers ? null : [...more.values()];
  };

  // ---- text: size, backdrop, and nothing drawn over it
  // what a text shows, as both rsvg and Chromium lay it out: XML whitespace (space, tab,
  // line break) is stripped at the ends and a run of spaces and tabs inside is one space.
  // Where they differ the text is refused: a line break inside (Chromium sets a space,
  // rsvg nothing) and a non-collapsible space at either end (Chromium keeps it, rsvg drops
  // it); each measured on a text with NBSPs, U+202F and a line break.
  const content = (t) =>
    memo(t, "content", () => {
      const raw = t.kids
        .filter((k) => k.text !== undefined)
        .map((k) => k.text)
        .join("")
        .replace(/\r\n?/g, "\n")
        .replace(/^[ \t\n]+|[ \t\n]+$/g, "");
      if (/\n/.test(raw)) return { s: raw, bad: "line break inside text" };
      const s = raw.replace(/[ \t]+/g, " ");
      if (/^\s|\s$/u.test(s))
        return { s, bad: "leading or trailing non-collapsible space in text" };
      const odd = [...s].find((ch) => !GLYPHS.has(ch));
      if (odd !== undefined)
        return {
          s,
          bad: `character U+${odd.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} in text (not in the measured glyph table)`,
        };
      return { s };
    }).s;
  const shown = [];
  for (const t of texts) {
    const s = content(t);
    if (!s) continue;
    const { bad } = t.memo.get("content");
    if (bad) {
      unsupported(`${bad}: "${s}"`);
      continue;
    }
    if ([...s].length > LIMITS.textChars) {
      issue(
        `too large: a text of ${[...s].length} characters (limit ${LIMITS.textChars})`,
      );
      continue;
    }
    if (prop(t, "font-family", "light") === undefined) {
      unsupported(
        "text without a font-family (the UA default font is not modelled)",
      );
      continue;
    }
    if (paintOf(t, "stroke", "dark").alpha > 0)
      unsupported("stroke on <text> from the dark rules");
    shown.push(t);
  }
  const shownSet = new Set(shown);
  const anchorOf = (t) => [num(t, "x") + t.dx, num(t, "y") + t.dy];
  const sizeOf = (t) => +prop(t, "font-size", "light");
  // the cells a text's glyphs can occupy, absolute, and their union
  const glyphsOf = (t) =>
    memo(t, "glyphs", () => {
      const [x, y] = anchorOf(t);
      const w = prop(t, "font-weight", "light").trim();
      // font matching sets a weight over 500 in the bold face
      const heavy = w === "bold" || +w > 500;
      const share = { start: 0, middle: 0.5, end: 1 }[
        prop(t, "text-anchor", "light").trim()
      ];
      const cells = glyphCells(content(t), sizeOf(t), heavy, share).map((c) => [
        c[0] + x,
        c[1] + y,
        c[2] + x,
        c[3] + y,
      ]);
      return cells.length ? { cells, box: union(cells) } : null;
    });
  const paints = (t, theme) => paintOf(t, "fill", theme).alpha > 0;
  // rects that carry a fill in a theme, for the figure-box floor
  const filledRects = (theme) =>
    shapes.filter(
      (e) =>
        e.tag === "rect" &&
        !isCanvas(e) &&
        paintOf(e, "fill", theme).alpha > 0 &&
        geom(e).w > 3 &&
        geom(e).h > 3,
    );
  const boxRects = Object.fromEntries(THEMES.map((t) => [t, filledRects(t)]));

  for (const t of shown) {
    const s = content(t);
    const [x, y] = anchorOf(t);
    const px = sizeOf(t);
    const glyphs = glyphsOf(t);
    const sizeIssues = {};
    for (const theme of THEMES) {
      sizeIssues[theme] = [];
      if (!paints(t, theme)) continue; // a text that paints nothing is not read
      // a figure box: the smallest filled rect around the anchor, stroked, over 40x20
      let under = null;
      for (const r of boxRects[theme]) {
        const [x0, y0, x1, y1] = geom(r).box;
        const ay = y - px * 0.35;
        if (x > x0 && x < x1 && ay > y0 && ay < y1)
          if (!under || geom(r).w * geom(r).h < geom(under).w * geom(under).h)
            under = r;
      }
      const isBox =
        under &&
        paintOf(under, "stroke", theme).alpha > 0 &&
        geom(under).w > 40 &&
        geom(under).h > 20;
      const shownPx = Math.round(px * 100) / 100;
      if (px < minText)
        sizeIssues[theme].push(`"${s}" is ${shownPx}px (floor ${minText}px)`);
      if (isBox && px < minBoxText)
        sizeIssues[theme].push(
          `"${s}" is ${shownPx}px inside a figure box (floor ${minBoxText}px)`,
        );
    }
    out.push(...sizeIssues.light);
    for (const m of sizeIssues.dark)
      if (!sizeIssues.light.includes(m)) out.push(`dark: ${m}`);

    if (!glyphs) continue;
    const region = {
      box: glyphs.box,
      meets: (b) => glyphs.cells.some((c) => overlaps(c, b)),
    };
    for (const theme of THEMES) {
      if (!paints(t, theme)) continue;
      const p = paintOf(t, "fill", theme);
      // a filled non-rect shape under a glyph: how much of it it covers is not modelled
      const other = otherFills[theme].find(
        (e) =>
          e.ord < t.ord &&
          overlaps(geom(e).box, glyphs.box) &&
          glyphs.cells.some((c) => fillMeets(e, c)),
      );
      if (other) {
        out.push(
          `${theme}: "${s}": cannot verify the backdrop (${article(other.tag)} drawn before it)`,
        );
        continue;
      }
      // the strokes drawn before the text under a glyph (a grid hairline is decoration)
      const strokes = shapes.filter(
        (e) =>
          e.ord < t.ord &&
          !isGridHairline(e) &&
          reachBox(e, "stroke", theme) &&
          overlaps(reachBox(e, "stroke", theme), glyphs.box) &&
          glyphs.cells.some((c) => strokeMeets(e, c, theme)),
      );
      const bgs = backdrop(theme, t.ord, region, strokes);
      if (!bgs) {
        issue(
          `too large: the backdrop of "${s}" in ${theme} has more than ${LIMITS.regions} regions or ${LIMITS.layers} colours`,
        );
        continue;
      }
      let worst = Infinity;
      for (const bg of bgs)
        worst = Math.min(worst, contrast(over(p.color, bg), bg));
      if (worst < 4.5)
        out.push(
          `${theme}: "${s}" ${p.raw} at ${worst.toFixed(2)}:1 (needs 4.5:1)`,
        );
      // anything painted after the text over its glyphs hides what the reader sees
      for (const e of drawn) {
        if (e.ord <= t.ord) continue;
        let cover = null;
        if (e.tag === "text") {
          const later = shownSet.has(e) && paints(e, theme) && glyphsOf(e);
          if (
            later &&
            overlaps(later.box, glyphs.box) &&
            later.cells.some((c) => glyphs.cells.some((d) => overlaps(c, d)))
          )
            cover = "fill";
        } else
          cover = SHAPES.get(e.tag).find((ch) => {
            const r = reachBox(e, ch, theme);
            return (
              r &&
              overlaps(r, glyphs.box) &&
              glyphs.cells.some((c) => channelMeets(e, ch, c, theme))
            );
          });
        if (cover)
          out.push(
            `${theme}: "${s}" is covered by ${article(e.tag)} drawn after it (${cover} ${paintOf(e, cover, theme).raw}): the audit cannot verify it`,
          );
      }
    }
  }

  // ---- non-text marks: series lines, arrows and edges, dots (filled or hollow), solid
  // bars, and small stroke-only tiles. Exempt: the fill of a full-canvas rect (the
  // page), rects that frame text (a container or a heat-table cell: the anchor of a text
  // painted in that theme lies inside it; the text is measured against it instead),
  // labeled swatches (a legend key), stripes ≤3px, hairlines drawn in the grid colour
  // (gridlines and rules are decoration; the axis labels carry the values), and, where the
  // same shape's stroke paints and is itself audited as a mark, the parts of its fill that
  // composite to exactly the colour under them (a hollow dot's centre). A translucent
  // colour is composited over each backdrop before the 3:1 check.
  const anchors = Object.fromEntries(
    THEMES.map((theme) => [
      theme,
      shown
        .filter((t) => paints(t, theme))
        .map((t) => {
          const [x, y] = anchorOf(t);
          return [x, y - sizeOf(t) * 0.35, y];
        }),
    ]),
  );
  const framesText = (e, theme) => {
    const [x0, y0, x1, y1] = geom(e).box;
    return anchors[theme].some(
      ([x, y]) => x > x0 && x < x1 && y > y0 && y < y1,
    );
  };
  // a labeled swatch (a legend key): a rect no larger than 32x20 with a rendered text
  // starting within 12px of its right edge, the baseline within 4px of its vertical
  // extent. The adjacent text carries what the graphic shows (WCAG 1.4.11).
  const isLabeledSwatch = (e, theme) => {
    const g = geom(e);
    if (g.w > 32 || g.h > 20) return false;
    const [, y0, x1, y1] = g.box;
    return anchors[theme].some(
      ([x, , base]) =>
        x >= x1 && x <= x1 + 12 && base >= y0 - 4 && base <= y1 + 4,
    );
  };
  // is a channel of a shape audited as a mark in a theme: it paints and no exemption applies
  const audited = (e, ch, theme) => {
    if (!reachBox(e, ch, theme)) return false; // paints nothing
    if (e.tag === "rect") {
      const g = geom(e);
      if (ch === "fill" && isCanvas(e)) return false;
      if (!(g.w > 3 && g.h > 3)) return false;
      if (framesText(e, theme) || isLabeledSwatch(e, theme)) return false;
    }
    return !(ch === "stroke" && isGridHairline(e));
  };
  for (const e of shapes)
    for (const ch of SHAPES.get(e.tag))
      for (const theme of THEMES) {
        if (!audited(e, ch, theme)) continue;
        const g = geom(e);
        const box = reachBox(e, ch, theme);
        const region = { box, meets: (b) => channelMeets(e, ch, b, theme) };
        const other = otherFills[theme].find(
          (o) =>
            o.ord < e.ord &&
            overlaps(geom(o).box, box) &&
            fillMeets(o, box) &&
            region.meets(geom(o).box),
        );
        if (other) {
          out.push(
            `${theme}: ${e.tag} ${ch}: cannot verify the backdrop (${article(other.tag)} drawn before it)`,
          );
          continue;
        }
        let bgs = backdrop(theme, e.ord, region);
        // a stroke is drawn over its own element's fill
        const own = paintOf(e, "fill", theme);
        if (
          bgs &&
          ch === "stroke" &&
          SHAPES.get(e.tag).includes("fill") &&
          g.area &&
          own.alpha > 0
        )
          bgs = withLayer(bgs, own.color);
        if (!bgs) {
          issue(
            `too large: the backdrop of a ${e.tag} ${ch} in ${theme} has more than ${LIMITS.regions} regions or ${LIMITS.layers} colours`,
          );
          continue;
        }
        const p = paintOf(e, ch, theme);
        // a fill the colour of its backdrop is a hollow mark's centre only when the
        // shape's own stroke carries the mark
        const hollow =
          ch === "fill" &&
          SHAPES.get(e.tag).includes("stroke") &&
          audited(e, "stroke", theme);
        let worst = Infinity;
        for (const bg of bgs) {
          const c = contrast(over(p.color, bg), bg);
          if (!(hollow && c === 1)) worst = Math.min(worst, c);
        }
        if (worst < 3) {
          const alpha =
            p.color.a < 1 ? ` (${Math.round(p.color.a * 100)}% opaque)` : "";
          out.push(
            `${theme}: ${e.tag} ${ch} ${p.raw}${alpha} at ${worst.toFixed(2)}:1 (marks need 3:1)`,
          );
        }
      }
  return done();
}

const article = (tag) => (/^[aeiou]/.test(tag) ? `an ${tag}` : `a ${tag}`);

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
