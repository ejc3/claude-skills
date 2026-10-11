#!/usr/bin/env node
// Static legibility audit of a rendered chart SVG, in both themes: every text's size,
// every text's contrast against what is drawn behind it, and every non-text mark's
// contrast against the page. The dark theme is the SVG's own
// `@media (prefers-color-scheme: dark)` rules applied to the elements they select,
// so the audit checks what a GitHub dark-mode reader sees.
//
//   node svg-audit.mjs [--min-text 9] [--min-box-text 11] chart.svg...
//   import { auditSvg } from "./svg-audit.mjs"   (for a repo's own test)
//
// Exits 1 when any file has an issue. Text needs 4.5:1, marks 3:1 (WCAG 2.x).

const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (a, b) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

// colour string → { rgb, a } (null for none / unparsable)
export const parseColor = (s) => {
  if (!s || s === "none" || s === "transparent") return null;
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return { rgb: [...m[1]].map((c) => parseInt(c + c, 16)), a: 1 };
  m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(s);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  return null;
};
const over = (top, bottom) => top.rgb.map((c, i) => c * top.a + bottom[i] * (1 - top.a));

const attrs = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};

// the dark rules: tag[attr="value"] → { prop: value }
const darkRules = (svg) => {
  const block = /@media \(prefers-color-scheme: dark\)\{([\s\S]*?)\}<\/style>/.exec(svg);
  const rules = new Map();
  if (!block) return rules;
  for (const m of block[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const props = {};
    for (const p of m[2].split(";")) {
      const [k, v] = p.split(":").map((x) => x && x.trim());
      if (k && v) props[k] = v;
    }
    for (const sel of m[1].split(",")) {
      const s = /^\s*([a-z]+)\[([a-z-]+)="([^"]+)"\]\s*$/.exec(sel);
      if (s)
        rules.set(`${s[1]}|${s[2]}|${s[3]}`, {
          ...(rules.get(`${s[1]}|${s[2]}|${s[3]}`) || {}),
          ...props,
        });
    }
  }
  return rules;
};

// effective paint of `attr` (fill/stroke) on an element in a theme
const paint = (el, attr, theme, rules) => {
  const raw = el.a[attr];
  if (!raw) return null;
  let c = parseColor(raw);
  if (theme === "dark") {
    const r = rules.get(`${el.tag}|${attr}|${raw}`);
    if (r && r[attr]) c = parseColor(r[attr]);
    if (c && r && r[`${attr}-opacity`]) c = { ...c, a: c.a * +r[`${attr}-opacity`] };
  }
  return c;
};

export function auditSvg(svg, { minText, minBoxText }) {
  const W = +/<svg[^>]*width="([\d.]+)"/.exec(svg)[1];
  const els = [];
  for (const m of svg.matchAll(/<(rect|circle|polyline|line|path)\b([^>]*)\/?>/g))
    els.push({ tag: m[1], a: attrs(m[2]) });
  const texts = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
    tag: "text",
    a: attrs(m[1]),
    s: m[2],
  }));
  const rules = darkRules(svg);
  const page = { light: [255, 255, 255], dark: null };
  const bgRect = els.find((e) => e.tag === "rect" && !e.a.x && +e.a.width === W);
  page.dark = (paint(bgRect, "fill", "dark", rules) || { rgb: [255, 255, 255] }).rgb;
  const rects = els
    .filter((e) => e.tag === "rect" && e !== bgRect && e.a.fill && e.a.fill !== "none")
    .map((e) => ({ e, x: +e.a.x || 0, y: +e.a.y || 0, w: +e.a.width, h: +e.a.height }))
    .filter((r) => r.w > 3 && r.h > 3);
  const out = [];
  for (const t of texts) {
    const x = +t.a.x;
    const y = +t.a.y;
    const size = +(t.a["font-size"] || 16);
    if (size < minText) out.push(`"${t.s}" is ${size}px (floor ${minText}px)`);
    // the smallest filled rect drawn under the text's anchor point
    const under = rects
      .filter(
        (r) => x > r.x && x < r.x + r.w && y - size * 0.35 > r.y && y - size * 0.35 < r.y + r.h,
      )
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    const isBox =
      under && under.e.a.stroke && under.e.a.stroke !== "none" && under.w > 40 && under.h > 20;
    if (isBox && size < minBoxText)
      out.push(`"${t.s}" is ${size}px inside a figure box (floor ${minBoxText}px)`);
    for (const theme of ["light", "dark"]) {
      const ink = paint(t, "fill", theme, rules) || {
        rgb: theme === "light" ? [0, 0, 0] : [0, 0, 0],
        a: 1,
      };
      let bg = page[theme];
      if (under) {
        const f = paint(under.e, "fill", theme, rules);
        if (f) bg = over(f, bg);
      }
      const c = contrast(over(ink, bg), bg);
      if (c < 4.5) out.push(`${theme}: "${t.s}" ${t.a.fill} at ${c.toFixed(2)}:1 (needs 4.5:1)`);
    }
  }
  // non-text marks: series lines and dots, and solid bars (not boxes, not stripes)
  for (const e of els) {
    if (e === bgRect) continue;
    let attr = null;
    if (e.tag === "circle") attr = e.a.fill && e.a.fill !== "none" ? "fill" : "stroke";
    else if (e.tag === "polyline") attr = "stroke";
    else if (e.tag === "rect") {
      const solid = parseColor(e.a.fill);
      const boxy = e.a.stroke && e.a.stroke !== "none";
      if (!solid || solid.a < 1 || boxy || +e.a.width <= 3 || +e.a.height <= 3) continue;
      attr = "fill";
    } else continue;
    for (const theme of ["light", "dark"]) {
      const c0 = paint(e, attr, theme, rules);
      if (!c0 || c0.a < 1) continue;
      const c = contrast(c0.rgb, page[theme]);
      // the page-coloured fill (a hollow dot's centre) is not a mark
      if (c === 1) continue;
      if (c < 3)
        out.push(`${theme}: ${e.tag} ${attr} ${e.a[attr]} at ${c.toFixed(2)}:1 (marks need 3:1)`);
    }
  }
  return out;
}

// CLI
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = { minText: 9, minBoxText: 11 };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-text") opt.minText = +args[++i];
    else if (args[i] === "--min-box-text") opt.minBoxText = +args[++i];
    else files.push(args[i]);
  }
  let bad = 0;
  for (const f of files) {
    const issues = auditSvg(readFileSync(f, "utf8"), opt);
    if (issues.length) bad++;
    console.log(`${issues.length ? "FAIL" : "ok  "} ${f}${issues.length ? "\n  " + issues.join("\n  ") : ""}`);
  }
  process.exit(bad ? 1 : 0);
}
