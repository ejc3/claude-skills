#!/usr/bin/env node
// Tests for svg-audit.mjs. Run: node test-svg-audit.mjs   (exit 1 on any failure)
// Fixtures are written to a temp directory that is removed at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./svg-audit.mjs", import.meta.url));
const { auditSvg } = await import(SCRIPT);
const tmp = mkdtempSync(join(tmpdir(), "svg-audit-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const cli = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
// run the CLI through a symlink to the script, as an installed skill is
let links = 0;
const viaLink = (...args) => {
  const link = join(tmp, `audit-link${links++}.mjs`);
  symlinkSync(SCRIPT, link);
  return spawnSync(process.execPath, [link, ...args], { encoding: "utf8" });
};
// write a chart file into the temp directory; returns its path
const chartFile = (name, svgText) => {
  const f = join(tmp, name);
  writeFileSync(f, svgText);
  return f;
};
const expectExit = (r, status, stdout) => {
  assert.equal(
    r.status,
    status,
    `exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`,
  );
  if (stdout) assert.match(r.stdout, stdout);
};
// every test but the F5 ones passes the floors explicitly, so one missing default
// does not mask the other findings when the suite runs against an older script
const audit = (svgText, opt) =>
  auditSvg(svgText, { minText: 9, minBoxText: 11, ...opt });
const issuesOf = (svgText, opt) => [...audit(svgText, opt)];

// ---- fixtures -------------------------------------------------------------------------------

// the font family list a chart generator writes on the root
const FONT = `font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif"`;
const DARK = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#e2e7ec}}`;
const BG_ONLY = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}}`;
const BG = `<rect width="200" height="100" fill="#ffffff"/>`;
const svg = ({
  style = DARK,
  bg = BG,
  body = "",
  head = `width="200" height="100" viewBox="0 0 200 100"`,
}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${head} ${FONT}>\n<style>${style}</style>\n${bg}\n${body}\n</svg>`;
const text = (s, extra = `fill="#1c2330"`, x = 10, y = 20) =>
  `<text x="${x}" y="${y}" font-size="12" ${extra}>${s}</text>`;
const has = (issues, re) =>
  assert.ok(
    issues.some((i) => re.test(i)),
    `no issue matching ${re} in ${JSON.stringify(issues)}`,
  );

// a clean chart is clean (control for every fixture below)
test("control: a clean chart has no issues and no notes", () => {
  const out = audit(
    svg({
      body:
        text("ok") + `<line x1="0" y1="50" x2="200" y2="50" stroke="#e4e8ec"/>`,
    }),
  );
  assert.deepEqual([...out], []);
  assert.deepEqual(out.notes, []);
});

// ---- finding 1: the CLI guard compared the symlink with the target ----------------------------

test("F1 CLI runs through a symlink and fails a bad chart", () => {
  const bad = chartFile(
    "f1-bad.svg",
    svg({ body: text("pale", `fill="#cccccc"`) }),
  );
  expectExit(viaLink(bad), 1, /FAIL/);
});

test("F1 CLI through a symlink passes a clean chart with output", () => {
  const good = chartFile("f1-good.svg", svg({ body: text("fine") }));
  expectExit(viaLink(good), 0, /^ok /);
});

// ---- finding 2: the dark rules parser -----------------------------------------------------

const PRETTY = `
  @media (prefers-color-scheme: dark) {
    rect[fill="#ffffff"] {
      fill: #0d1117;
    }
    text[fill='#1c2330'] {
      fill: #1c2330;
    }
  }
`;
test("F2 control: compact dark rules flag dark text left dark", () => {
  const compact = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#1c2330}}`;
  has(issuesOf(svg({ style: compact, body: text("x") })), /^dark: "x"/);
});
test("F2 whitespace, newlines and single quotes in the dark block are parsed", () => {
  has(issuesOf(svg({ style: PRETTY, body: text("x") })), /^dark: "x"/);
});
test("F2 a comment in <style> is unsupported", () => {
  has(
    issuesOf(svg({ style: `/* recolours */${DARK}`, body: text("x") })),
    /^unsupported CSS comment in <style>/,
  );
});
test("F2 spacing variants of the media query are accepted", () => {
  const style = `@media (prefers-color-scheme:dark){rect[fill="#ffffff"]{fill:#0d1117}}`;
  has(issuesOf(svg({ style, body: text("x") })), /^dark: "x"/);
});
test("F2 several dark blocks and comma selector lists are merged", () => {
  const style = `
    @media (prefers-color-scheme: dark) { rect[fill="#ffffff"] { fill: #0d1117 } }
    @media (prefers-color-scheme: dark) {
      text[fill="#1c2330"], text[fill="#595959"] { fill: #222222 }
    }`;
  const out = issuesOf(
    svg({ style, body: text("a") + text("b", `fill="#595959"`, 10, 40) }),
  );
  has(out, /^dark: "a" #222222/);
  has(out, /^dark: "b" #222222/);
});
test("F2 stroke rules are applied to marks", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}line[stroke="#444444"]{stroke:#222222}}`;
  has(
    issuesOf(
      svg({
        style,
        body: `<line x1="0" y1="5" x2="90" y2="5" stroke="#444444"/>`,
      }),
    ),
    /^dark: line stroke #222222/,
  );
});
test("F2 class selectors in the dark block are reported, not dropped", () => {
  const style = `@media (prefers-color-scheme: dark){.label{fill:#e2e7ec}}`;
  has(
    issuesOf(svg({ style, body: text("x") })),
    /unsupported selector "\.label"/,
  );
});
test("F2 a bare tag selector in the dark block is reported", () => {
  const style = `@media (prefers-color-scheme: dark){text{fill:#e2e7ec}}`;
  has(issuesOf(svg({ style, body: text("x") })), /unsupported selector "text"/);
});
test("F2 a rule outside the dark block is reported", () => {
  has(
    issuesOf(svg({ style: `text{fill:#000}`, body: text("x") })),
    /^unsupported CSS "text": only @media \(prefers-color-scheme: dark\) blocks are read/,
  );
});
test("F2 another @media block is reported", () => {
  const style = `@media (max-width: 400px){text{font-size:8px}}`;
  has(
    issuesOf(svg({ style, body: text("x") })),
    /unsupported CSS "@media \(max-width: 400px\)"/,
  );
});

test("F2 an @import is reported, alone or ahead of a rule", () => {
  has(
    issuesOf(svg({ style: `@import url(x.css);`, body: text("x") })),
    /unsupported CSS "@import url\(x\.css\);"/,
  );
  has(
    issuesOf(
      svg({ style: `@import url(x.css); text{fill:#000}`, body: text("x") }),
    ),
    /unsupported CSS "@import url\(x\.css\); text"/,
  );
});

// ---- finding 3: background detection and canvas size ----------------------------------------------

test("F3 a background rect with x=0 y=0 is the page", () => {
  const out = audit(
    svg({
      style: BG_ONLY,
      bg: `<rect x="0" y="0" width="200" height="100" fill="#ffffff"/>`,
      body: text("x"),
    }),
  );
  has([...out], /^dark: "x"/); // dark page is #0d1117 (from the rule), the text stays dark
  assert.deepEqual(out.notes, []);
});
test("F3 an SVG with only a viewBox, or a 100% background rect, is unsupported", () => {
  const out = audit(
    svg({
      style: BG_ONLY,
      head: `viewBox="0 0 200 100"`,
      bg: `<rect width="100%" height="100%" fill="#ffffff"/>`,
      body: text("x"),
    }),
  );
  has(
    [...out],
    /^unsupported <svg> without a numeric width, height and viewBox/,
  );
  has([...out], /^unsupported width="100%" on <rect>/);
});
test("F3 width=100% on the root is unsupported", () => {
  const out = audit(
    svg({
      style: BG_ONLY,
      head: `width="100%" viewBox="0 0 200 100"`,
      body: text("x"),
    }),
  );
  has([...out], /^unsupported width="100%" on <svg>/);
});
test("F3 no background rect: white and #0d1117 pages are assumed and reported", () => {
  const out = audit(
    svg({
      style: BG_ONLY,
      bg: "",
      style: "",
      body: text("x", `fill="#777777"`) + text("y", "", 10, 40),
    }),
  );
  has([...out], /^light: "x" #777777 at 4\.48:1/);
  has([...out], /^dark: "y" black at/);
  assert.ok(
    out.notes.some((n) => /no background rect/.test(n)),
    JSON.stringify(out.notes),
  );
});

// ---- finding 4: text size and ink --------------------------------------------------------------------

test("F4 font-size with px units is unsupported", () => {
  has(
    issuesOf(
      svg({
        body: `<text x="10" y="20" font-size="8px" fill="#1c2330">tiny</text>`,
      }),
    ),
    /^unsupported font-size="8px" on <text>/,
  );
});
test("F4 font-size in any unit, and keywords, are unsupported", () => {
  const sizes = ["6pt", "0.5em", "50%", "small", "1rem"];
  const body = sizes
    .map(
      (v, i) =>
        `<text x="10" y="${20 + i * 20}" font-size="${v}" fill="#1c2330">u${i}</text>`,
    )
    .join("");
  const out = issuesOf(svg({ body }));
  sizes.forEach((v) =>
    has(
      out,
      new RegExp(`^unsupported font-size="${v.replace(".", "\\.")}" on <text>`),
    ),
  );
});
test("F4 a unitless font-size is read; a style attribute on text is unsupported", () => {
  const body =
    `<text x="10" y="20" font-size="7.5" fill="#1c2330">bare</text>` +
    `<text x="10" y="40" style="font-size:6px" fill="#1c2330">css</text>`;
  const out = issuesOf(svg({ body }));
  has(out, /"bare" is 7\.5px/);
  has(out, /^unsupported attribute style on <text>/);
});
test("F4 a font-size in the dark rules is unsupported", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#e2e7ec;font-size:7px}}`;
  has(
    issuesOf(svg({ style, body: text("x") })),
    /^unsupported CSS declaration "font-size:7px" in the dark rules/,
  );
});
test("F4 a dark rule with a font-size in em is unsupported", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#e2e7ec;font-size:1em}}`;
  has(
    issuesOf(svg({ style, body: text("x") })),
    /^unsupported CSS declaration "font-size:1em" in the dark rules/,
  );
});
test("F4 an unreadable font-size is reported, not passed", () => {
  has(
    issuesOf(
      svg({
        body: `<text x="10" y="20" font-size="calc(1px+2px)" fill="#1c2330">odd</text>`,
      }),
    ),
    /^unsupported font-size="calc\(1px\+2px\)" on <text>/,
  );
});
test("F4 font-size on a <g> is unsupported", () => {
  has(
    issuesOf(
      svg({
        body: `<g font-size="8"><text x="10" y="20" fill="#1c2330">small</text></g>`,
      }),
    ),
    /^unsupported attribute font-size on <g>/,
  );
});
test("F4 fill on a <g> is unsupported", () => {
  const body = `<g fill="#cccccc"><text x="10" y="20" font-size="12">pale</text></g>`;
  has(issuesOf(svg({ body })), /^unsupported attribute fill on <g>/);
});
test("F4 a dark rule selecting a <g> is unsupported", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}g[fill="#1c2330"]{fill:#e2e7ec}}`;
  const body = `<g fill="#1c2330"><text x="10" y="20" font-size="12">ink</text></g>`;
  has(
    issuesOf(svg({ style, body })),
    /^unsupported selector "g\[fill="#1c2330"\]"/,
  );
});
test("F4 <tspan> runs are outside the subset: reported, never passed", () => {
  const body =
    `<text x="10" y="20" font-size="12" fill="#1c2330">label ` +
    `<tspan fill="#cccccc">pale</tspan><tspan font-size="7">tiny</tspan></text>`;
  has(
    issuesOf(svg({ body })),
    /^unsupported <tspan>: the audit cannot verify it/,
  );
});
test("F4 text without a fill is black in both themes, so it fails on the dark page", () => {
  const out = issuesOf(svg({ body: text("bare", "") }));
  assert.ok(!out.some((i) => /^light:/.test(i)), JSON.stringify(out));
  has(out, /^dark: "bare" black at/);
});
test("F4 fill:none text draws nothing and is not flagged", () => {
  assert.deepEqual(issuesOf(svg({ body: text("ghost", `fill="none"`) })), []);
});
test("F4 a url() fill on text is unsupported", () => {
  has(
    issuesOf(svg({ body: text("grad", `fill="url(#g)"`) })),
    /^unsupported fill="url\(#g\)" on <text>/,
  );
});
test("F4 entities in text are read", () => {
  const body = `<text x="10" y="20" font-size="8" fill="#cccccc">a &amp; b</text>`;
  const out = issuesOf(svg({ body }));
  has(out, /"a & b" is 8px/);
  has(out, /^light: "a & b" #cccccc/);
});

// ---- finding 5: defaults ---------------------------------------------------------------------------------

const raw = (svgText, ...opt) => [...auditSvg(svgText, ...opt)];
test("F5 auditSvg(svg) with no options applies the default floors", () => {
  has(
    raw(
      svg({
        body: `<text x="10" y="20" font-size="8" fill="#1c2330">tiny</text>`,
      }),
    ),
    /"tiny" is 8px \(floor 9px\)/,
  );
});
test("F5 auditSvg(svg, {}) keeps the floors", () => {
  has(
    raw(
      svg({
        body: `<text x="10" y="20" font-size="8" fill="#1c2330">tiny</text>`,
      }),
      {},
    ),
    /"tiny" is 8px/,
  );
});
test("F5 the box floor applies by default inside a figure box", () => {
  const body = `<rect x="5" y="5" width="150" height="50" fill="#f3f6fb" stroke="#c5d4ea"/><text x="10" y="30" font-size="10" fill="#1c2330">boxed</text>`;
  has(raw(svg({ body })), /"boxed" is 10px inside a figure box \(floor 11px\)/);
});
test("F5 a non-numeric floor throws instead of disabling the check", () => {
  assert.throws(() => auditSvg(svg({}), { minText: NaN }), TypeError);
  assert.throws(() => auditSvg(svg({}), { minBoxText: "11" }), TypeError);
});

// ---- finding 6: marks, grid colour, light page ------------------------------------------------------------

const marks = (body, opt, extra = {}) => issuesOf(svg({ body, ...extra }), opt);
test("F6 a series line with low contrast is flagged", () => {
  has(
    marks(`<line x1="0" y1="50" x2="100" y2="50" stroke="#dddddd"/>`),
    /^light: line stroke #dddddd/,
  );
  has(
    marks(`<polyline points="0,0 5,5" fill="none" stroke="#dddddd"/>`),
    /^light: polyline stroke #dddddd/,
  );
});
test("F6 an arrow path and its arrowhead are flagged", () => {
  has(
    marks(`<path d="M0 0L50 50" fill="none" stroke="#dddddd"/>`),
    /^light: path stroke #dddddd/,
  );
  has(
    marks(`<path d="M0 0L5 5L0 9Z" fill="#dddddd"/>`),
    /^light: path fill #dddddd/,
  );
});
test("F6 a small tile's outline and a hollow dot's stroke are flagged", () => {
  has(
    marks(
      `<rect x="5" y="60" width="12" height="12" fill="none" stroke="#dddddd"/>`,
    ),
    /^light: rect stroke #dddddd/,
  );
  const out = marks(
    `<circle cx="20" cy="70" r="4" fill="#ffffff" stroke="#dddddd"/>`,
  );
  has(out, /^light: circle stroke #dddddd/);
  assert.ok(
    !out.some((i) => /circle fill/.test(i)),
    "the page-coloured centre is not a mark",
  );
});
test("F6 stroke on a <g> is unsupported", () => {
  has(
    marks(`<g stroke="#dddddd"><line x1="0" y1="50" x2="100" y2="50"/></g>`),
    /^unsupported attribute stroke on <g>/,
  );
});
test("F6 grid hairlines in the default grid colour are exempt", () => {
  assert.deepEqual(
    marks(`<line x1="0" y1="50" x2="100" y2="50" stroke="#e4e8ec"/>`),
    [],
  );
});
test("F6 the grid colour is configurable", () => {
  const lines = `<line x1="0" y1="50" x2="100" y2="50" stroke="#f0f0f0"/><line x1="0" y1="60" x2="100" y2="60" stroke="#e4e8ec"/>`;
  const out = marks(lines, { gridColor: "#f0f0f0" });
  assert.equal(
    out.filter((i) => /^light: line stroke/.test(i)).length,
    1,
    JSON.stringify(out),
  );
  has(out, /line stroke #e4e8ec/);
});
test("F6 the light page colour comes from the background rect", () => {
  const style = "";
  const bg = `<rect width="200" height="100" fill="#222222"/>`;
  // white text on a dark light-theme page is fine; a near-black line on it is not
  assert.deepEqual(
    marks(
      text("lit", `fill="#ffffff"`) +
        `<line x1="0" y1="50" x2="100" y2="50" stroke="#ffffff"/>`,
      undefined,
      { style, bg },
    ),
    [],
  );
  has(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="#333333"/>`,
      undefined,
      { style, bg },
    ),
    /^light: line stroke #333333/,
  );
});
test("F6 marks are checked against the dark page after the dark rules", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}line[stroke="#444444"]{stroke:#1a1f27}}`;
  has(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="#444444"/>`,
      undefined,
      { style },
    ),
    /^dark: line stroke #1a1f27/,
  );
});
test("F6 a solid bar is checked and a thin stripe is not", () => {
  has(
    marks(`<rect x="5" y="30" width="40" height="20" fill="#dddddd"/>`),
    /^light: rect fill #dddddd/,
  );
  assert.deepEqual(
    marks(`<rect x="5" y="30" width="40" height="2" fill="#dddddd"/>`),
    [],
  );
});

// ---- finding 8: translucent marks, and which rects frame text ---------------------------------------

test("F8 a translucent near-white bar on white is flagged; fill-opacity is unsupported", () => {
  has(
    marks(
      `<rect x="5" y="30" width="40" height="20" fill="rgba(0,0,0,0.04)"/>`,
    ),
    /^light: rect fill rgba\(0,0,0,0\.04\) \(4% opaque\) at 1\.\d+:1/,
  );
  has(
    marks(
      `<rect x="5" y="30" width="40" height="20" fill="#dddddd" fill-opacity="0.5"/>`,
    ),
    /^unsupported attribute fill-opacity on <rect>/,
  );
});
test("F8 a half-transparent pale series line is flagged; stroke-opacity is unsupported", () => {
  has(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="rgba(170,170,170,0.5)"/>`,
    ),
    /^light: line stroke rgba\(170,170,170,0\.5\) \(50% opaque\) at/,
  );
  has(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="#aaaaaa" stroke-opacity="0.5"/>`,
    ),
    /^unsupported attribute stroke-opacity on <line>/,
  );
});
test("F8 opacity on a group is unsupported", () => {
  has(
    marks(
      `<g opacity="0.3"><line x1="0" y1="50" x2="100" y2="50" stroke="#555555"/></g>`,
    ),
    /^unsupported attribute opacity on <g>/,
  );
});
test("F8 a translucent mark that still reaches 3:1 passes", () => {
  assert.deepEqual(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="rgba(0,0,0,0.8)"/>`,
      undefined,
      { style: "" },
    ),
    [],
  );
});
test("F8 a translucent mark is composited over each theme's own page", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}}`;
  const out = marks(
    `<line x1="0" y1="50" x2="100" y2="50" stroke="rgba(204,204,204,0.5)"/>`,
    undefined,
    { style },
  );
  has(out, /^light: line stroke rgba\(204,204,204,0\.5\) \(50% opaque\)/);
  assert.ok(!out.some((i) => /^dark:/.test(i)), JSON.stringify(out));
});
test("F8 a bordered 200x20 bar with no text inside is flagged on fill and stroke", () => {
  const out = marks(
    `<rect x="0" y="40" width="200" height="20" fill="#dddddd" stroke="#dddddd"/>`,
  );
  has(out, /^light: rect fill #dddddd at/);
  has(out, /^light: rect stroke #dddddd at/);
});
test("F8 a tinted rect with text inside stays exempt, translucent or not", () => {
  assert.deepEqual(
    marks(
      `<rect x="5" y="5" width="60" height="30" fill="rgba(31,138,77,0.16)"/>` +
        text("1.2s", `fill="#1c2330"`, 10, 25) +
        `<rect x="80" y="5" width="60" height="30" fill="#f4f6f8" stroke="#e8ecef"/>` +
        text("3.4s", `fill="#000000"`, 85, 25),
    ),
    [],
  );
});
test("F8 text elsewhere does not exempt a rect", () => {
  has(
    marks(
      `<rect x="5" y="30" width="40" height="20" fill="#dddddd" stroke="#dddddd"/>` +
        text("far", `fill="#1c2330"`, 120, 80),
    ),
    /^light: rect fill #dddddd/,
  );
});

test("F8 a labeled swatch (20x12 tinted rect, label 5px right) is exempt", () => {
  assert.deepEqual(
    marks(
      `<rect x="20" y="40" width="20" height="12" fill="rgba(31,138,77,0.16)"/>` +
        text("fastest", `fill="#1c2330"`, 45, 50),
    ),
    [],
  );
});
test("F8 the same swatch with its label 40px away is flagged", () => {
  has(
    marks(
      `<rect x="20" y="40" width="20" height="12" fill="rgba(31,138,77,0.16)"/>` +
        text("fastest", `fill="#1c2330"`, 80, 50),
    ),
    /^light: rect fill rgba\(31,138,77,0\.16\)/,
  );
});
test("F8 a swatch label on a different line, or left of the rect, does not exempt it", () => {
  const rect = `<rect x="20" y="40" width="20" height="12" fill="rgba(31,138,77,0.16)"/>`;
  has(
    marks(rect + text("below", `fill="#1c2330"`, 45, 80)),
    /^light: rect fill/,
  );
  has(
    marks(rect + text("left", `fill="#1c2330"`, 10, 50)),
    /^light: rect fill/,
  );
});
test("F8 a 60x40 rect with a label beside it is too large to be a swatch", () => {
  has(
    marks(
      `<rect x="20" y="30" width="60" height="40" fill="rgba(31,138,77,0.16)"/>` +
        text("fastest", `fill="#1c2330"`, 85, 50),
    ),
    /^light: rect fill rgba\(31,138,77,0\.16\)/,
  );
});

// ---- finding 7: SVG's initial values (an unset fill is black) --------------------------------------

test("F7 a rect with no fill is a black box: text over it is measured against black", () => {
  const body = `<rect x="5" y="5" width="100" height="40"/>${text("on black", `fill="#1c2330"`, 10, 30)}`;
  has(issuesOf(svg({ body })), /^light: "on black" #1c2330 at/);
});
test("F7 light text on a rect with no fill passes; the rect frames the text, so it is not a mark", () => {
  const body = `<rect x="5" y="5" width="100" height="40"/>${text("on black", `fill="#ffffff"`, 10, 30)}`;
  assert.deepEqual(issuesOf(svg({ body })), []);
});
test("F7 a rect with no fill and no text inside is a black bar: it fails on the dark page", () => {
  const body = `<rect x="5" y="5" width="100" height="40"/>`;
  assert.deepEqual(issuesOf(svg({ body })), [
    "dark: rect fill black at 1.11:1 (marks need 3:1)",
  ]);
});
test("F7 a shape with no fill is a black mark: it fails on the dark page", () => {
  const out = marks(`<circle cx="20" cy="70" r="4"/>`);
  has(out, /^dark: circle fill black at/);
  assert.ok(!out.some((i) => /^light:/.test(i)), JSON.stringify(out));
});
test("F7 a line has no fill channel and an explicit fill:none shape is not a mark", () => {
  assert.deepEqual(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="#777777"/><circle cx="20" cy="70" r="4" fill="none" stroke="#777777"/>`,
    ),
    [],
  );
});
test("F7 a fill on a <g> is unsupported, not inherited", () => {
  has(
    marks(`<g fill="none"><circle cx="20" cy="70" r="4"/></g>`),
    /^unsupported attribute fill on <g>/,
  );
});

// ---- colour forms: a colour the audit cannot read is an issue, never a pass ------------------------

const CSS_NAMES = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];
const line = (stroke) =>
  `<line x1="0" y1="50" x2="100" y2="50" stroke="${stroke}"/>`;
// the "at N:1" part of the light-theme issue on the line
const ratio = (stroke) =>
  /at ([\d.]+):1/.exec(
    marks(line(stroke)).find((i) => /^light: line stroke/.test(i)) ?? "",
  )?.[1];

test("G1 all 148 CSS named colours are read (none reported as unreadable)", () => {
  assert.equal(new Set(CSS_NAMES).size, 148);
  for (const name of CSS_NAMES) {
    const out = marks(line(name));
    assert.ok(
      !out.some((i) => /cannot read/.test(i)),
      `${name}: ${JSON.stringify(out)}`,
    );
  }
});
test("G1 pale named colours are flagged, not skipped", () => {
  for (const name of ["gainsboro", "whitesmoke", "lightgray", "yellow", "snow"])
    has(marks(line(name)), new RegExp(`^light: line stroke ${name} at `));
});
test("G1 a named colour gets the contrast of its hex value (case-insensitive)", () => {
  assert.equal(ratio("gainsboro"), ratio("#dcdcdc"));
  assert.ok(ratio("gainsboro"));
  assert.equal(ratio("Yellow"), ratio("#ffff00"));
  assert.equal(ratio("lightgrey"), ratio("#d3d3d3"));
  assert.equal(ratio("rebeccapurple"), undefined); // #663399 is dark enough: no issue
});
test("G1 a pale named colour on text and on a mark is flagged with its name", () => {
  has(marks(line("gainsboro")), /^light: line stroke gainsboro at /);
  has(
    marks(text("pale", `fill="gainsboro"`)),
    /^light: "pale" gainsboro at [\d.]+:1 \(needs 4\.5:1\)/,
  );
});
test("G1 hsl() and hsla() equal their rgb value", () => {
  assert.equal(ratio("hsl(60, 100%, 50%)"), ratio("#ffff00"));
  assert.equal(ratio("hsla(60, 100%, 50%, 1)"), ratio("#ffff00"));
  assert.equal(ratio("hsl(0 0% 86.27%)"), ratio("rgb(220 220 220)"));
  assert.equal(ratio("hsl(0.1666667turn 100% 50%)"), ratio("#ffff00"));
  assert.equal(ratio("hsl(120deg 100% 25%)"), ratio("green"));
  assert.ok(ratio("hsl(60, 100%, 50%)"));
});
test("G1 space-separated rgb() with / alpha and % channels", () => {
  assert.equal(ratio("rgb(220 220 220)"), ratio("#dcdcdc"));
  assert.equal(ratio("rgb(86.27% 86.27% 86.27%)"), ratio("#dcdcdc"));
  assert.equal(
    ratio("rgba(220 220 220 / 0.5)"),
    ratio("rgba(220,220,220,0.5)"),
  );
  assert.equal(ratio("rgb(0 0 0 / 50%)"), ratio("rgba(0,0,0,0.5)"));
  assert.ok(ratio("rgb(220 220 220 / 50%)"));
  has(
    marks(line("rgb(255 255 0 / 50%)")),
    /^light: line stroke rgb\(255 255 0 \/ 50%\) \(50% opaque\)/,
  );
});
test("G1 text in hsl() and space-separated rgb() is contrast-checked", () => {
  has(marks(text("a", `fill="hsl(0 0% 86%)"`)), /^light: "a" hsl/);
  has(marks(text("b", `fill="rgb(220 220 220 / 100%)"`)), /^light: "b" rgb/);
});
test("G1 a colour form outside the subset on a mark is unsupported", () => {
  for (const bad of [
    "url(#grad)",
    "var(--ink)",
    "color(srgb 1 1 1)",
    "lab(50% 40 59)",
    "hsl(0 0% none)",
    "rgb(1 2)",
    "rgb(1, 2 3)",
    "rgb(1 2 3 / 0.5 / 1)",
    "notacolour",
    "currentColor",
  ]) {
    const out = marks(line(bad));
    assert.ok(
      out.includes(
        `unsupported stroke="${bad}" on <line>: the audit cannot verify it`,
      ),
      JSON.stringify(out),
    );
  }
});
test("G1 a url() fill on a circle is unsupported, with exit 1 from the CLI", () => {
  const body = `<circle cx="20" cy="70" r="4" fill="url(#g)"/>`;
  has(marks(body), /^unsupported fill="url\(#g\)" on <circle>/);
  const f = chartFile("unreadable.svg", svg({ body }));
  expectExit(cli(f), 1, /FAIL/);
});
test("G1 transparent and none draw nothing and are not issues", () => {
  assert.deepEqual(marks(line("transparent")), []);
  assert.deepEqual(marks(text("t", `fill="transparent"`)), []);
});
test("G1 currentColor and the color attribute are unsupported", () => {
  const out = marks(`<g color="gainsboro">${line("currentColor")}</g>`);
  has(out, /^unsupported attribute color on <g>/);
  has(out, /^unsupported stroke="currentColor" on <line>/);
});
test("G1 --grid-color accepts a named colour", () => {
  const f = chartFile("gridname.svg", svg({ body: line("gainsboro") }));
  expectExit(cli(f), 1);
  expectExit(cli("--grid-color", "gainsboro", f), 0);
});

// ---- dark rules resolve by specificity, then source order ------------------------------------------

const rules = (...r) =>
  `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}${r.join("")}}`;
test("G3 an attribute-only selector is unsupported", () => {
  const style = rules(
    `text[fill="#000"]{fill:#000}`,
    `[fill="#000"]{fill:#fff}`,
  );
  const body = text("x", `fill="#000"`);
  const out = issuesOf(svg({ style, body }));
  has(out, /^unsupported selector "\[fill="#000"\]"/);
  has(out, /^dark: "x" #000 at/);
});
test("G3 a later tag[attr] rule wins over an earlier one", () => {
  const style = rules(
    `text[fill="#000"]{fill:#fff}`,
    `text[fill="#000"]{fill:#000}`,
  );
  has(
    issuesOf(svg({ style, body: text("x", `fill="#000"`) })),
    /^dark: "x" #000 at/,
  );
});
test("G3 equal specificity: the later rule wins", () => {
  const style = rules(
    `text[fill="#000"]{fill:#000}`,
    `text[fill="#000"]{fill:#fff}`,
  );
  assert.deepEqual(
    issuesOf(svg({ style, body: text("x", `fill="#000"`) })),
    [],
  );
});
test("G3 a selector with two attribute conditions is unsupported", () => {
  const style = rules(
    `[fill="#000"][font-size="12"]{fill:#fff}`,
    `text[fill="#000"]{fill:#000}`,
  );
  has(
    issuesOf(svg({ style, body: text("x", `fill="#000"`) })),
    /^unsupported selector "\[fill="#000"\]\[font-size="12"\]"/,
  );
});
test("G3 a rule may set fill and stroke only", () => {
  const style = rules(`text[fill="#000"]{font-size:20px;fill:#fff}`);
  const out = issuesOf(svg({ style, body: text("x", `fill="#000"`) }));
  has(out, /^unsupported CSS declaration "font-size:20px" in the dark rules/);
  assert.ok(!out.some((i) => /^dark: "x"/.test(i)), JSON.stringify(out));
});

// ---- CLI -----------------------------------------------------------------------------------------------------------

test("CLI --grid-color changes the hairline exemption", () => {
  const f = chartFile(
    "grid.svg",
    svg({ body: `<line x1="0" y1="50" x2="100" y2="50" stroke="#f0f0f0"/>` }),
  );
  expectExit(cli(f), 1);
  expectExit(cli("--grid-color", "#f0f0f0", f), 0);
  expectExit(cli("--grid-color=#f0f0f0", f), 0);
});
test("CLI a bad --grid-color is a usage error naming the problem", () => {
  const f = chartFile("grid2.svg", svg({}));
  const r = cli("--grid-color", "not-a-colour", f);
  expectExit(r, 2);
  assert.match(r.stderr, /gridColor must be a colour/);
  assert.match(r.stderr, /usage:/);
});
test("CLI --min-text sets the floor and a non-number is a usage error", () => {
  const f = chartFile(
    "floor.svg",
    svg({ body: `<text x="10" y="20" font-size="10" fill="#1c2330">t</text>` }),
  );
  expectExit(cli(f), 0);
  expectExit(cli("--min-text", "11", f), 1);
  expectExit(cli("--min-text=11", f), 1);
  expectExit(cli("--min-text", "abc", f), 2);
  expectExit(cli("--min-text", "", f), 2);
  expectExit(cli("--min-box-text", "-1", f), 2);
});
test("CLI exits 2 with no files, an unknown flag, a missing value or an unreadable file", () => {
  expectExit(cli(), 2);
  expectExit(cli("--bogus", "x.svg"), 2);
  expectExit(cli("x.svg", "--min-text"), 2);
  expectExit(cli(join(tmp, "missing.svg")), 2);
});
test("CLI -h and --help print usage and exit 0", () => {
  expectExit(cli("-h"), 0, /usage:/);
  expectExit(cli("--help"), 0, /usage:/);
});
test("CLI prints notes next to an ok result", () => {
  const f = chartFile(
    "nobg.svg",
    svg({ bg: "", style: "", body: text("y", `fill="#000000"`) }),
  );
  // black text on the assumed #0d1117 dark page
  expectExit(cli(f), 1, /note: no background rect/);
});

// ---- the page is resolved per theme --------------------------------------------------------

test("BG a canvas rect that is none in light and white in dark is the dark page", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="none"]{fill:#ffffff}text[fill="#000000"]{fill:#ffffff}}`;
  const out = issuesOf(
    svg({
      style,
      bg: `<rect width="200" height="100" fill="none"/>`,
      body: text("x", `fill="#000000"`),
    }),
  );
  has(out, /^dark: "x" #ffffff at 1\.00:1/);
  assert.ok(!out.some((i) => /^light:/.test(i)), JSON.stringify(out));
});
test("BG a canvas rect filled in light and none in dark leaves the dark default page", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:none}}`;
  const out = audit(svg({ style, body: text("x", `fill="#1c2330"`) }));
  has([...out], /^dark: "x"/);
  assert.ok(
    out.notes.some((n) => /no background rect/.test(n)),
    JSON.stringify(out.notes),
  );
});

// ---- what the audit cannot read or order is an issue, never a pass --------------------------

const CANVAS = (fill) => `<rect width="200" height="100" fill="${fill}"/>`;

test("PG1 a full-canvas background with a url() paint is unsupported", () => {
  has(
    issuesOf(
      svg({
        style: "",
        bg: CANVAS("url(#g)"),
        body: text("x", `fill="#000000"`),
      }),
    ),
    /^unsupported fill="url\(#g\)" on <rect>/,
  );
});
test("PG1 a dark rule that gives the background a url() paint is unsupported", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:url(#g)}}`;
  has(
    issuesOf(svg({ style, body: text("x", `fill="#000000"`) })),
    /^unsupported CSS declaration "fill:url\(#g\)" in the dark rules/,
  );
});
test("PG1 a url() background fails the CLI", () => {
  const f = chartFile(
    "pg1.svg",
    svg({
      style: "",
      bg: CANVAS("url(#g)"),
      body: text("x", `fill="#000000"`),
    }),
  );
  expectExit(cli(f), 1, /unsupported fill="url\(#g\)"/);
});
test("PG1 a rect with a url() fill behind text is unsupported", () => {
  const body = `<rect x="5" y="5" width="100" height="40" fill="url(#g)"/>${text("x", `fill="#000000"`, 10, 30)}`;
  has(
    issuesOf(svg({ style: "", body })),
    /^unsupported fill="url\(#g\)" on <rect>/,
  );
});

const BOX = (fill, extra = "") =>
  `<rect x="5" y="5" width="100" height="40" fill="${fill}"${extra}/>`;
test("PG2 a rect drawn after the text covers it: white text on black, then a white rect", () => {
  const body = `${BOX("#000000")}${text("x", `fill="#ffffff"`, 10, 30)}${BOX("#ffffff")}`;
  const out = issuesOf(svg({ style: "", body }));
  has(out, /^light: "x" is covered by a rect drawn after it/);
  has(out, /^dark: "x" is covered by a rect drawn after it/);
});
test("PG2 a full-canvas rect drawn after the text covers it", () => {
  const body = `${text("x", `fill="#000000"`)}${CANVAS("#ffffff")}`;
  has(
    issuesOf(svg({ style: "", bg: "", body })),
    /^light: "x" is covered by a rect drawn after it/,
  );
});
test("PG2 the normal order (rect, then its text) is clean", () => {
  const body = `${BOX("#000000")}${text("x", `fill="#ffffff"`, 10, 30)}`;
  assert.deepEqual(issuesOf(svg({ style: "", body })), []);
});
test("PG2 a rect drawn after the text that does not reach the text is fine", () => {
  const body = `${text("x", `fill="#000000"`, 10, 30)}<rect x="120" y="5" width="60" height="40" fill="#000000"/>`;
  assert.ok(!issuesOf(svg({ style: "", body })).some((i) => /covered/.test(i)));
});
test("PG2 a smaller rect drawn after a larger one is the backdrop", () => {
  const small = `<rect x="8" y="10" width="60" height="30" fill="#000000"/>`;
  const body = `<rect x="5" y="5" width="100" height="40" fill="#ffffff"/>${small}${text("x", `fill="#ffffff"`, 10, 30)}`;
  assert.deepEqual(issuesOf(svg({ style: "", body })), []);
});
test("PG2 a larger rect drawn after a smaller one hides it: the larger is the backdrop", () => {
  const small = `<rect x="8" y="10" width="60" height="30" fill="#ffffff"/>`;
  const body = `${small}<rect x="5" y="5" width="100" height="40" fill="#000000"/>${text("x", `fill="#ffffff"`, 10, 30)}`;
  assert.deepEqual(issuesOf(svg({ style: "", body })), []);
});
test("PG2 the same nesting with a white smaller rect on top fails white text", () => {
  const small = `<rect x="8" y="10" width="60" height="30" fill="#ffffff"/>`;
  const body = `<rect x="5" y="5" width="100" height="40" fill="#000000"/>${small}${text("x", `fill="#ffffff"`, 10, 30)}`;
  has(issuesOf(svg({ style: "", body })), /^light: "x" #ffffff at 1\.00:1/);
});

test("PG3 the page under a mark is the full-canvas stack painted before it", () => {
  const body = `<rect x="20" y="60" width="100" height="20" fill="#dddddd"/>`;
  const out = issuesOf(
    svg({ style: "", bg: CANVAS("#000000") + CANVAS("#ffffff"), body }),
  );
  has(out, /^light: rect fill #dddddd at 1\.\d\d:1/);
  has(out, /^dark: rect fill #dddddd at 1\.\d\d:1/);
});
test("PG3 a mark drawn between two canvas rects sees only the first, and the second hides it", () => {
  const body = `<rect x="20" y="60" width="100" height="20" fill="#dddddd"/>`;
  const out = issuesOf(
    svg({ style: "", bg: CANVAS("#000000"), body: body + CANVAS("#ffffff") }),
  );
  assert.ok(!out.some((i) => /rect fill #dddddd at/.test(i)), String(out));
  has(
    out,
    /^light: rect fill is covered by a rect drawn after it \(fill #ffffff\)/,
  );
  has(
    out,
    /^dark: rect fill is covered by a rect drawn after it \(fill #ffffff\)/,
  );
});
test("PG3 a translucent canvas layer is composited over the one beneath", () => {
  const out = issuesOf(
    svg({
      style: "",
      bg: CANVAS("#000000") + CANVAS("rgba(255,255,255,0.5)"),
      body: `<rect x="20" y="60" width="100" height="20" fill="#808080"/>`,
    }),
  );
  has(out, /^light: rect fill #808080 at 1\.0\d:1/);
});
test("PG3 per-theme recolours still apply to each canvas layer", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}}`;
  const out = issuesOf(
    svg({
      style,
      bg: CANVAS("#000000") + CANVAS("#ffffff"),
      body: `<rect x="20" y="60" width="100" height="20" fill="#dddddd"/>`,
    }),
  );
  has(out, /^light: rect fill #dddddd at 1\.\d\d:1/);
  assert.ok(!out.some((i) => /^dark:/.test(i)), String(out));
});

// ---- the supported subset: one paint stack, unsupported constructs are issues -------------------

const WHITE = CANVAS("#ffffff");
const FULL_BLACK = CANVAS("#000000");
const plainSvg = (body, bg = WHITE) => svg({ style: "", bg, body });
const unsupported = (body, re) => has(issuesOf(plainSvg(body)), re);

test("S1 opacity on a <g> is unsupported", () => {
  const body = `<g opacity="0.5">${FULL_BLACK}${FULL_BLACK}</g>${text("x", `fill="#ffffff"`)}`;
  has(issuesOf(plainSvg(body)), /^unsupported attribute opacity on <g>/);
});
test("S1 a half-transparent canvas is composited: white text on the gray composite", () => {
  const body = `${CANVAS("rgba(0,0,0,0.5)")}${text("x", `fill="#ffffff"`)}`;
  const out = issuesOf(plainSvg(body));
  has(out, /^light: "x" #ffffff at 3\.98:1 \(needs 4\.5:1\)/);
  assert.ok(!out.some((i) => /unsupported/.test(i)), JSON.stringify(out));
});

const CANVAS_STROKE = (stroke) =>
  `<rect width="200" height="100" fill="none" stroke="${stroke}" stroke-width="8"/>`;
test("S2 a canvas-sized stroke-only rect is mark-checked on its stroke", () => {
  has(
    issuesOf(svg({ style: "", bg: CANVAS_STROKE("#dddddd") })),
    /^light: rect stroke #dddddd at 1\.\d\d:1 \(marks need 3:1\)/,
  );
});
test("S2 a canvas-sized rect with a url() stroke is unsupported", () => {
  has(
    issuesOf(svg({ style: "", bg: CANVAS_STROKE("url(#g)") })),
    /^unsupported stroke="url\(#g\)" on <rect>/,
  );
});

test("S3 an element with zero alpha drawn after the text does not cover it", () => {
  const ink = text("x", `fill="#000000"`, 10, 30);
  for (const cover of [
    BOX("rgba(0,0,0,0)"),
    BOX("transparent"),
    BOX("#00000000"),
    `<rect width="200" height="100" fill="rgba(0,0,0,0)"/>`,
  ])
    assert.deepEqual(issuesOf(plainSvg(ink + cover)), [], cover);
  for (const attr of [` opacity="0"`, ` fill-opacity="0"`])
    has(
      issuesOf(plainSvg(ink + BOX("black", attr))),
      /^unsupported attribute (fill-)?opacity on <rect>/,
    );
});

test("S4 one paint stack: a full-canvas rect drawn over a local rect hides it", () => {
  const body = `${BOX("#000000")}${WHITE}${text("x", `fill="#ffffff"`, 10, 30)}`;
  has(issuesOf(plainSvg(body)), /^light: "x" #ffffff at 1\.00:1/);
  const dark = `${BOX("#000000")}${WHITE}${text("x", `fill="#000000"`, 10, 30)}`;
  assert.deepEqual(issuesOf(plainSvg(dark)), []);
});

test("S6 a black path drawn after black text and over it covers it", () => {
  const body = `${text("x", `fill="#000000"`, 10, 30)}<path d="M5 15L120 15L120 40L5 40z" fill="#000000"/>`;
  has(
    issuesOf(plainSvg(body)),
    /^light: "x" is covered by a path drawn after it/,
  );
});
test("S6 a scale() transform is unsupported, not a 1.2px text read as 12px", () => {
  unsupported(
    `<g transform="scale(0.1)">${text("t", `fill="#000000"`)}</g>`,
    /^unsupported transform="scale\(0\.1\)" on <g>/,
  );
});
test("S6 a rotate() transform is unsupported, and a transform on text at all", () => {
  unsupported(
    `<g transform="rotate(-90 10 20)">${text("t", `fill="#000000"`)}</g>`,
    /^unsupported transform="rotate\(-90 10 20\)" on <g>/,
  );
  unsupported(
    `<text x="10" y="20" font-size="12" fill="#000000" transform="translate(1 1)">t</text>`,
    /^unsupported attribute transform on <text>/,
  );
});
test("S6 <use> is unsupported", () => {
  unsupported(
    `<defs><rect id="r" width="10" height="10"/></defs><use href="#r" x="20" y="20"/>`,
    /^unsupported <use>/,
  );
});
test("S6 <image> is unsupported", () => {
  unsupported(
    `<image href="x.png" width="20" height="20"/>`,
    /^unsupported <image>/,
  );
});
test("S6 <clipPath> and clip-path are unsupported", () => {
  const out = issuesOf(
    plainSvg(
      `<clipPath id="c"><rect width="10" height="10"/></clipPath><rect x="5" y="5" width="40" height="40" fill="#000000" clip-path="url(#c)"/>`,
    ),
  );
  has(out, /^unsupported <clipPath>/);
  has(out, /^unsupported attribute clip-path on <rect>/);
});
test("S6 a mask is unsupported", () => {
  const out = issuesOf(
    plainSvg(
      `<defs><mask id="m"><rect width="10" height="10" fill="#ffffff"/></mask></defs><rect x="5" y="5" width="40" height="40" fill="#000000" mask="url(#m)"/>`,
    ),
  );
  has(out, /^unsupported <defs>/);
  has(out, /^unsupported attribute mask on <rect>/);
});
test("S6 a filter is unsupported", () => {
  unsupported(
    `<defs><filter id="f"/></defs>${text("t", `fill="#000000" filter="url(#f)"`)}`,
    /^unsupported attribute filter on <text>/,
  );
});
test("S6 <tspan> is unsupported", () => {
  unsupported(
    `<text x="10" y="20" font-size="12" fill="#000000">a <tspan dy="4">b</tspan></text>`,
    /^unsupported <tspan>/,
  );
});
test("S6 a curve command in a path is unsupported", () => {
  unsupported(
    `<path d="M0 0C10 10 20 20 30 30" stroke="#000000" fill="none"/>`,
    /^unsupported path command C on <path>/,
  );
});
test("S6 text dx is unsupported", () => {
  unsupported(
    text("t", `fill="#000000" dx="4"`),
    /^unsupported attribute dx on <text>/,
  );
});

// a fixture in the consumer charts' style: translate groups, an href wrapper, rgba cell
// fills, M/L/z arrowheads drawn after their labels without overlapping them, a style block
// of dark recolours
const CONSUMER = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200" role="img" aria-label="fixture" font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif" style="font-variant-numeric:tabular-nums">
<style>@media (prefers-color-scheme: dark){
rect[fill="#ffffff"]{fill:#0d1117}
text[fill="#1c2330"]{fill:#e2e7ec}
text[fill="#6b7885"]{fill:#9aa6b1}
line[stroke="#e4e8ec"]{stroke:#2b333c}
line[stroke="#8794a1"],path[stroke="#8794a1"]{stroke:#6f7c88}
path[fill="#8794a1"]{fill:#6f7c88}
rect[fill="#f3f6fb"]{fill:#172435}rect[stroke="#c5d4ea"]{stroke:#34507a}
rect[fill="#fcf4f0"]{fill:#2b1b15}rect[stroke="#e2c0b0"]{stroke:#6c4232}
circle[fill="#3a4656"]{fill:#a7b6c8}
}</style>
<rect width="420" height="200" fill="#ffffff"/>
<g transform="translate(4 0)">
<text x="16" y="24" font-size="17" fill="#1c2330" font-weight="650">A figure title</text>
<text x="16" y="42" font-size="12" fill="#6b7885">a subtitle line</text>
<rect x="16" y="62" width="150" height="50" rx="6" fill="#fcf4f0" stroke="#e2c0b0" stroke-width="1"/>
<text x="27" y="80" font-size="12" fill="#1c2330" font-weight="600">the seed</text>
<text x="27" y="96" font-size="11" fill="#1c2330">computes every task</text>
<line x1="166" y1="87" x2="214" y2="87" stroke="#8794a1" stroke-width="1.25"/>
<text x="190" y="80" font-size="11" fill="#6b7885" text-anchor="middle">upload</text>
<path d="M222 87L215.5 90L215.5 84z" fill="#8794a1"/>
<rect x="222" y="62" width="150" height="50" rx="6" fill="#f3f6fb" stroke="#c5d4ea" stroke-width="1"/>
<text x="233" y="80" font-size="12" fill="#1c2330" font-weight="600">the cache</text>
<rect x="16" y="126" width="80" height="24" rx="3" fill="rgba(31,138,77,0.16)"/>
<text x="56" y="142" font-size="12" fill="#1c2330" text-anchor="middle">1.5s</text>
<rect x="100" y="126" width="80" height="24" rx="3" fill="rgba(200,120,40,0.22)"/>
<text x="140" y="142" font-size="12" fill="#1c2330" text-anchor="middle">×6.6</text>
<line x1="16" y1="160" x2="372" y2="160" stroke="#e4e8ec"/>
<circle cx="20" cy="172" r="4" fill="#3a4656"/>
<text x="30" y="176" font-size="11" fill="#1c2330">a legend entry</text>
</g>
<a href="../../bench/example.json">
<text x="20" y="192" font-size="10" fill="#6b7885">source: bench/example.json</text>
</a>
</svg>`;
test("S8 a fixture in the consumer charts' style has no issues and no notes", () => {
  const out = audit(CONSUMER);
  assert.deepEqual([...out], []);
  assert.deepEqual(out.notes, []);
});

test("S9 text over part of a rect is checked against both sides of its edge", () => {
  // white text starting on a black rect and running past its right edge onto white
  const body = `<rect x="5" y="5" width="30" height="40" fill="#000000"/>${text("long label", `fill="#ffffff"`, 10, 30)}`;
  has(issuesOf(plainSvg(body)), /^light: "long label" #ffffff at 1\.00:1/);
});
test("S9 a grid hairline under a text is decoration; a darker line under it is a backdrop", () => {
  const under = (stroke) =>
    `<line x1="30" y1="0" x2="30" y2="100" stroke="${stroke}"/>${text("label", `fill="#6b7885"`, 10, 30)}`;
  assert.deepEqual(issuesOf(plainSvg(under("#e4e8ec"))), []);
  has(issuesOf(plainSvg(under("#8794a1"))), /^light: "label" #6b7885 at/);
});

// ---- closure review 2: one regression test per finding ----------------------------------------

// a document of the given size with a white canvas
const doc = (body, { w = 100, h = 100, root = "", style = "" } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}${root}>${style ? `<style>${style}</style>` : ""}<rect width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;
const darkRules = (r) => `@media (prefers-color-scheme: dark){${r}}`;
const none = (svgText) => assert.deepEqual(issuesOf(svgText), []);

test("C2-01 a font shorthand in a style attribute is unsupported", () => {
  has(
    issuesOf(
      doc(`<text x="10" y="20" font-size="12" fill="#000000">x</text>`, {
        root: ` style="font:1px Arial"`,
      }),
    ),
    /^unsupported CSS declaration "font:1px Arial"/,
  );
  has(
    issuesOf(
      doc(`<text x="10" y="20" fill="#000000" style="font:1px Arial">x</text>`),
    ),
    /^unsupported attribute style on <text>/,
  );
});
test("C2-02 root dimensions with units are unsupported", () => {
  const s = doc(
    `<text x="10" y="20" font-size="12" fill="#000000">x</text>`,
  ).replace(`width="100" height="100"`, `width="1em" height="1em"`);
  has(issuesOf(s), /^unsupported width="1em" on <svg>/);
});
test("C2-03 !important is unsupported", () => {
  has(
    issuesOf(
      doc(`<text x="10" y="20" font-size="12" fill="#000000">x</text>`, {
        style: darkRules(`text[fill="#000000"]{fill:#ffffff!important}`),
      }),
    ),
    /^unsupported CSS !important/,
  );
});
test("C2-04 a comment in a style attribute is unsupported", () => {
  has(
    issuesOf(
      doc("", { root: ` style="/*c*/font-variant-numeric:tabular-nums"` }),
    ),
    /^unsupported CSS comment/,
  );
});
test("C2-05 <style media> is unsupported", () => {
  const s = doc(
    `<text x="10" y="20" font-size="12" fill="#000000">x</text>`,
  ).replace(
    "<rect",
    `<style media="print">${darkRules(`text[fill="#000000"]{fill:#ffffff}`)}</style><rect`,
  );
  has(issuesOf(s), /^unsupported attribute media on <style>/);
});
test("C2-06 CDATA is unsupported", () => {
  has(
    issuesOf(
      doc(
        `<text x="10" y="20" font-size="12" fill="#ffffff"><![CDATA[x]]></text>`,
      ),
    ),
    /^unsupported CDATA section/,
  );
});
test("C2-07 opacity, inherit or not, is unsupported", () => {
  has(
    issuesOf(
      doc(
        `<g opacity=".5"><text x="10" y="20" font-size="12" fill="#ffffff" opacity="inherit">x</text></g>`,
      ),
    ),
    /^unsupported attribute opacity on <text>/,
  );
});
test("C2-08 element opacity over fill and stroke is unsupported", () => {
  has(
    issuesOf(
      doc(
        `<rect x="10" y="10" width="80" height="80" fill="#000000" stroke="#000000" stroke-width="40" opacity=".5"/><text x="12" y="45" font-size="12" fill="#000000">x</text>`,
      ),
    ),
    /^unsupported attribute opacity on <rect>/,
  );
});
test("C2-09 text that paints nothing is not held to the size floor", () => {
  none(doc(`<text x="10" y="20" font-size="1" fill="none">x</text>`));
});
test("C2-10 a text that paints nothing does not exempt the rect around it", () => {
  const body = `<rect x="10" y="10" width="50" height="50" fill="#aaaaaa"/><text x="20" y="40" font-size="12" fill="none">x</text>`;
  has(issuesOf(doc(body)), /^light: rect fill #aaaaaa at 2\.32:1/);
  const lit = `<rect x="10" y="10" width="50" height="50" fill="#aaaaaa"/><text x="20" y="40" font-size="12" fill="#000000">x</text>`;
  has(
    issuesOf(doc(lit, { style: darkRules(`text[fill="#000000"]{fill:none}`) })),
    /^dark: rect fill #aaaaaa at 2\.32:1/,
  );
});
test("C2-11 group opacity is unsupported, whatever the group holds", () => {
  has(
    issuesOf(
      doc(
        `<g opacity=".9"><text x="10" y="20" font-size="12" fill="#000000">x</text><rect width="20" height="20" fill="none"/></g>`,
      ),
    ),
    /^unsupported attribute opacity on <g>/,
  );
});
test("C2-12 the figure-box floor applies in the theme whose rules make the box", () => {
  const body = `<rect x="1" y="1" width="80" height="50" fill="#fefefe"/><text x="20" y="20" font-size="10" fill="#000000">x</text>`;
  const out = issuesOf(
    doc(body, { style: darkRules(`rect[fill="#fefefe"]{stroke:#000000}`) }),
  );
  has(out, /^dark: "x" is 10px inside a figure box \(floor 11px\)/);
  assert.ok(
    !out.some((i) => /^"x" is 10px inside/.test(i)),
    JSON.stringify(out),
  );
});
test("C2-13 a stroke the colour of the page fails at 1:1", () => {
  has(
    issuesOf(doc(`<line x1="10" y1="10" x2="90" y2="90" stroke="#ffffff"/>`)),
    /^light: line stroke #ffffff at 1\.00:1/,
  );
});
test("C2-14 a zero-width stroke paints nothing", () => {
  none(
    doc(
      `<line x1="10" y1="10" x2="90" y2="90" stroke="#aaaaaa" stroke-width="0"/>`,
    ),
  );
});
test("C2-15 a butt cap ends at its endpoint: no cover beyond it", () => {
  none(
    doc(
      `<text x="50" y="50" font-size="12" fill="#000000">A</text><line x1="10" y1="45" x2="45" y2="45" stroke="#000000" stroke-width="20"/>`,
    ),
  );
});
test("C2-16 <ellipse> is unsupported", () => {
  has(
    issuesOf(
      doc(
        `<ellipse cx="50" cy="50" rx="40" ry="10" fill="none" stroke="#000000"/>`,
      ),
    ),
    /^unsupported <ellipse>/,
  );
});
test("C2-17 a path with fewer than three vertices has no fill area", () => {
  none(
    doc(
      `<text x="50" y="55" font-size="12" fill="#000000">A</text><path d="M0 0L100 100"/>`,
    ),
  );
});
test("C2-18 <polygon> is unsupported; a concave path is tested on its own area", () => {
  has(
    issuesOf(doc(`<polygon points="10,10 90,10 90,90 10,90" fill="#777777"/>`)),
    /^unsupported <polygon>/,
  );
  none(
    doc(
      `<rect x="40" y="40" width="20" height="30" fill="#555555"/><path d="M10 10L90 10L90 90L70 90L70 30L30 30L30 90L10 90z" fill="#777777"/>`,
    ),
  );
});
test("C2-19 a filled path under a mark leaves its backdrop unverified", () => {
  has(
    issuesOf(
      doc(
        `<path d="M10 10L90 10L90 90L10 90z" fill="#555555"/><line x1="90" y1="20" x2="90" y2="80" stroke="#777777"/>`,
      ),
    ),
    /^light: line stroke: cannot verify the backdrop \(a path drawn before it\)/,
  );
});
test("C2-20 a stroke's backdrop includes its element's own fill", () => {
  has(
    issuesOf(
      doc(
        `<circle cx="50" cy="50" r="25" fill="#555555" stroke="#777777" stroke-width="4"/>`,
      ),
    ),
    /^light: circle stroke #777777 at 1\.66:1/,
  );
});
test("C2-21 an exponent in path data is a number, not a command", () => {
  none(doc(`<path d="M10 10 9e1 90" stroke="#000000" fill="none"/>`));
});
test("C2-22 very long text and point lists are reported as too large, not thrown", () => {
  const long = auditSvg(
    doc(
      `<text y="20" font-size="12" fill="#000000">${"x".repeat(130000)}</text>`,
      { w: 2000000 },
    ),
  );
  assert.ok(Array.isArray(long));
  has([...long], /^too large: /);
  const pts = auditSvg(
    doc(
      `<polyline points="${"0,0 ".repeat(130000)}" fill="none" stroke="#000000"/>`,
    ),
  );
  assert.ok(Array.isArray(pts));
  has([...pts], /^too large: /);
});
test("C2-23 deep nesting is reported as too large, not thrown", () => {
  const out = auditSvg(doc("<g>".repeat(7000) + "</g>".repeat(7000)));
  assert.ok(Array.isArray(out));
  has([...out], /^too large: nesting/);
});
test("C2-24 an invalid entity is an issue, not a throw", () => {
  has(
    [
      ...auditSvg(
        doc(
          `<text x="10" y="20" font-size="12" fill="#000000">&#1114112;</text>`,
        ),
      ),
    ],
    /^invalid entity &#1114112;/,
  );
});

test("W1 text widths cover DejaVu Sans: a label that clears a bar in Arial but not in DejaVu is covered", () => {
  // 10px "the whole workspace's source, once" from x=20 ends at 180.3 in Arial's metrics
  // and at 200.6 in DejaVu Sans'; a bar drawn after it starts at 196
  const body = `<text x="20" y="118" font-size="10" fill="#000000">the whole workspace's source, once</text><rect x="196" y="110" width="30" height="13" fill="#7a8899"/>`;
  has(
    issuesOf(doc(body, { w: 300, h: 200 })),
    /^light: "the whole workspace's source, once" is covered by a rect drawn after it/,
  );
  // the same bar 10px further right clears it
  none(doc(body.replace('x="196"', 'x="206"'), { w: 300, h: 200 }));
});

test("Z1 auditSvg returns an array for hundreds of random mutations of a chart, never throws", () => {
  // a deterministic generator (mulberry32), so a failure reproduces
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const bits = [
    "<",
    ">",
    "/",
    '"',
    "'",
    "=",
    "&",
    "&#0;",
    "&#x110000;",
    "&nbsp;",
    ";",
    "#",
    "<g>",
    "</g>",
    "<![CDATA[",
    "]]>",
    "<!--",
    "-->",
    "{",
    "}",
    "@media",
    "[",
    "]",
    "e9",
    "-",
    ".",
    "1e400",
    "NaN",
    "z",
    "C",
    " ",
    "\n",
    "<text>",
    "</text>",
    "M",
    "L",
    "0",
    "9".repeat(40),
    "rgba(",
    ")",
    "translate(",
    "url(#a)",
  ];
  for (let n = 0; n < 400; n++) {
    let s = CONSUMER;
    for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) {
      const at = Math.floor(rand() * s.length);
      const len = Math.floor(rand() * 40);
      const op = rand();
      if (op < 0.35) s = s.slice(0, at) + s.slice(at + len);
      else if (op < 0.7) s = s.slice(0, at) + pick(bits) + s.slice(at);
      else
        s =
          s.slice(0, at) +
          s.slice(at, at + len).repeat(1 + Math.floor(rand() * 20)) +
          s.slice(at);
    }
    let out;
    assert.doesNotThrow(() => {
      out = auditSvg(s);
    }, `mutation ${n}`);
    assert.ok(Array.isArray(out) && Array.isArray(out.notes), `mutation ${n}`);
  }
});

// ---- closure review 4: generator-emittable constructs ----------------------------------------

test("C4-01 a self-intersecting filled path is unsupported", () => {
  has(
    issuesOf(doc(`<path d="M10 10L90 90L10 90L90 10Z" fill="#aaaaaa"/>`)),
    /^unsupported self-intersecting fill on <path>/,
  );
  // a simple outline is still audited
  has(
    issuesOf(doc(`<path d="M10 10L90 10L90 90L10 90Z" fill="#aaaaaa"/>`)),
    /^light: path fill #aaaaaa at 2\.32:1/,
  );
});
test("C4-02 inner NBSPs keep their width: the glyph after them is covered", () => {
  has(
    issuesOf(
      doc(
        `<text x="0" y="20" font-size="20" fill="#000000">A&#160;&#160;&#160;&#160;&#160;&#160;A</text><rect x="40" width="40" height="30" fill="#000000"/>`,
        { h: 50 },
      ),
    ),
    /^light: "A +A" is covered by a rect drawn after it/,
  );
});
test("C4-02 leading or trailing NBSP, and a newline inside text, are unsupported (renderers differ)", () => {
  for (const s of ["&#160;A", "A&#160;", "A&#8239;"])
    has(
      issuesOf(
        doc(`<text x="10" y="20" font-size="12" fill="#000000">${s}</text>`),
      ),
      /^unsupported leading or trailing non-collapsible space in text/,
    );
  has(
    issuesOf(
      doc(`<text x="10" y="20" font-size="12" fill="#000000">A\nB</text>`),
    ),
    /^unsupported line break inside text/,
  );
  // spaces and newlines around the text are stripped by every renderer
  none(
    doc(`<text x="10" y="20" font-size="12" fill="#000000">\n  A  B\n</text>`),
  );
});
test("C4-03 a stroke drawn before a translucent rect is under it, not over it", () => {
  has(
    issuesOf(
      doc(
        `<line y1="20" x2="100" y2="20" stroke="#000000" stroke-width="40"/><rect width="100" height="100" fill="#ffffff80"/><text x="10" y="25" font-size="16" fill="#757575">X</text>`,
      ),
    ),
    /^light: "X" #757575 at 1\.17:1/,
  );
});
test("C4-04 a weight over 500 is set in bold: weight 550 uses bold widths", () => {
  has(
    issuesOf(
      doc(
        `<text x="0" y="20" font-size="20" font-weight="550" fill="#000000">llllll</text><rect x="34" width="16" height="30" fill="#000000"/>`,
        { h: 50 },
      ),
    ),
    /^light: "llllll" is covered by a rect drawn after it/,
  );
});
test("C4-05 a character outside the measured glyph table is unsupported", () => {
  has(
    issuesOf(
      doc(
        `<text x="20" y="110" font-size="100" fill="#000000">&#7858;</text><rect width="100" height="9" fill="#000000"/>`,
        { w: 150, h: 150 },
      ),
    ),
    /^unsupported character U\+1EB2 in text/,
  );
});
test("C4-07 attribute values and style text are XML-normalized before matching", () => {
  const ink = `<text x="10" y="20" font-size="12" fill="#000000">A</text>`;
  has(
    issuesOf(
      doc(ink, { style: darkRules(`text[fill="&#35;000000"]{fill:#ffffff}`) }),
    ),
    /^dark: "A" #ffffff at 1\.00:1/,
  );
  has(
    issuesOf(
      doc(`<text x="10" y="20" font-size="12" fill="\n#000000">A</text>`, {
        style: darkRules(`text[fill=" #000000"]{fill:#ffffff}`),
      }),
    ),
    /^dark: "A" #ffffff at 1\.00:1/,
  );
});
test("C4-10 width and height must equal the viewBox exactly", () => {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10.5 10.5" ${FONT}><rect width="10.5" height="10.5" fill="#ffffff"/><text x="1" y="9" font-size="9" fill="#000000">I</text></svg>`;
  has(issuesOf(s), /^unsupported viewBox scaling/);
});
test("C4-12 invalid legacy colour functions are unsupported", () => {
  for (const c of ["rgb(0%,0,0)", "hsl(0,0,0)", "rgba(0,0%,0,1)"])
    has(
      issuesOf(doc(`<rect x="10" y="10" width="20" height="20" fill="${c}"/>`)),
      new RegExp(
        `^unsupported fill="${c.replace(/[()%]/g, "\\$&")}" on <rect>`,
      ),
    );
  // the valid forms are read
  for (const c of ["rgb(0,0,0)", "rgb(0%,0%,0%)", "hsl(0,0%,0%)", "hsl(0 0 0)"])
    none(doc(`<rect x="10" y="10" width="20" height="20" fill="${c}"/>`));
});
test("C4-15 names that are object properties are unsupported, not crashes or passes", () => {
  has(issuesOf(doc(`<constructor/>`)), /^unsupported <constructor>/);
  has(
    issuesOf(doc("", { root: ` __proto__="x"` })),
    /^unsupported attribute __proto__ on <svg>/,
  );
  for (const d of ["constructor:x", "__proto__:x"])
    has(
      issuesOf(doc("", { root: ` style="${d}"` })),
      new RegExp(`^unsupported CSS declaration "${d}"`),
    );
  has(
    issuesOf(
      doc(`<rect x="1" y="1" width="9" height="9" fill="constructor"/>`),
    ),
    /^unsupported fill="constructor" on <rect>/,
  );
});

// ---- review: a fill equal to its backdrop is exempt only as a hollow mark's centre -------------

test("HOLLOW an opaque page-coloured bar with no stroke is flagged at 1:1 in both themes", () => {
  const bar = `<rect x="20" y="20" width="40" height="40" fill="#ffffff"/>`;
  const out = marks(bar);
  has(out, /^light: rect fill #ffffff at 1\.00:1 \(marks need 3:1\)/);
  has(out, /^dark: rect fill #0d1117 at 1\.00:1 \(marks need 3:1\)/);
  expectExit(cli(chartFile("hollow-bar.svg", svg({ body: bar }))), 1, /FAIL/);
});
test("HOLLOW a page-coloured fill whose stroke paints nothing is flagged", () => {
  for (const stroke of [
    `stroke="none"`,
    `stroke="#1c2330" stroke-width="0"`,
    `stroke="#1c233000"`,
  ])
    has(
      marks(`<circle cx="50" cy="50" r="10" fill="#ffffff" ${stroke}/>`),
      /^light: circle fill #ffffff at 1\.00:1/,
    );
});
test("HOLLOW a page-coloured fill outlined in the grid colour is flagged: its outline is not a hairline", () => {
  // a grid hairline is one open segment, which has no fill; the outline is a mark
  has(
    marks(`<path d="M10 10L60 10L60 60Z" fill="#ffffff" stroke="#e4e8ec"/>`),
    /^light: path stroke #e4e8ec at 1\.23:1/,
  );
});
test("HOLLOW a hollow dot (page-coloured fill, dark stroke) still passes in both themes", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}circle[fill="#ffffff"]{fill:#0d1117}circle[stroke="#1c2330"]{stroke:#e2e7ec}}`;
  const dot = `<circle cx="50" cy="50" r="6" fill="#ffffff" stroke="#1c2330" stroke-width="2"/>`;
  assert.deepEqual(marks(dot, undefined, { style }), []);
  expectExit(cli(chartFile("hollow-dot.svg", svg({ style, body: dot }))), 0);
});

// ---- review: paint drawn after a mark that hides it ------------------------------------------

test("HIDE a line under a later theme-aware full-canvas rect is covered in both themes", () => {
  const style = darkRules(
    `rect[fill="#ffffff"]{fill:#0d1117}line[stroke="#000000"]{stroke:#ffffff}`,
  );
  const line = `<line x1="10" y1="50" x2="90" y2="50" stroke="#000000" stroke-width="2"/>`;
  const out = issuesOf(
    doc(line + `<rect width="100" height="100" fill="#ffffff"/>`, { style }),
  );
  has(
    out,
    /^light: line stroke is covered by a rect drawn after it \(fill #ffffff\): the audit cannot verify it/,
  );
  has(
    out,
    /^dark: line stroke is covered by a rect drawn after it \(fill #0d1117\)/,
  );
  none(doc(line, { style })); // control: the same line with nothing over it
});
test("HIDE a mark held by a later rect, circle, path fill or a thick stroke is covered", () => {
  const dot = `<circle cx="50" cy="50" r="2" fill="#000000"/>`;
  for (const [cover, re] of [
    [
      `<rect x="40" y="40" width="20" height="20" fill="#777777"/>`,
      /^light: circle fill is covered by a rect drawn after it \(fill #777777\)/,
    ],
    [
      `<circle cx="50" cy="50" r="10" fill="#777777"/>`,
      /^light: circle fill is covered by a circle drawn after it/,
    ],
    [
      `<path d="M10 10L90 10L90 90L10 90Z" fill="#777777"/>`,
      /^light: circle fill is covered by a path drawn after it \(fill #777777\)/,
    ],
    [
      `<line x1="10" y1="50" x2="90" y2="50" stroke="#777777" stroke-width="10"/>`,
      /^light: circle fill is covered by a line drawn after it \(stroke #777777\)/,
    ],
    [
      `<rect x="46" y="46" width="8" height="8" fill="none" stroke="#777777" stroke-width="10"/>`,
      /^light: circle fill is covered by a rect drawn after it \(stroke #777777\)/,
    ],
    [
      `<circle cx="50" cy="50" r="5" fill="none" stroke="#777777" stroke-width="12"/>`,
      /^light: circle fill is covered by a circle drawn after it \(stroke #777777\)/,
    ],
  ])
    has(issuesOf(doc(dot + cover)), re);
});
test("HIDE partial overlap is not a hide: dots on a series line, a notch around a dot", () => {
  none(
    doc(
      `<polyline points="10,50 50,20 90,50" fill="none" stroke="#1c2330" stroke-width="2"/><circle cx="10" cy="50" r="3" fill="#1c2330"/><circle cx="50" cy="20" r="3" fill="#1c2330"/><circle cx="90" cy="50" r="3" fill="#1c2330"/>`,
    ),
  );
  // a concave path whose notch holds the dot does not cover it
  none(
    doc(
      `<circle cx="50" cy="50" r="2" fill="#000000"/><path d="M10 10L90 10L90 90L70 90L70 30L30 30L30 90L10 90z" fill="#777777"/>`,
    ),
  );
});
test("HIDE a mark seen through a later stroke's unpainted inside is not covered", () => {
  const out = issuesOf(
    doc(
      `<circle cx="50" cy="50" r="2" fill="#000000"/><rect x="44" y="44" width="12" height="12" fill="none" stroke="#777777" stroke-width="10"/>`,
    ),
  );
  assert.ok(!out.some((i) => /covered/.test(i)), JSON.stringify(out));
});
test("HIDE a shape's own stroke over its fill is not a hide", () => {
  none(
    doc(
      `<circle cx="50" cy="50" r="2" fill="#777777" stroke="#000000" stroke-width="6"/>`,
    ),
  );
});
test("HIDE a later layer that paints nothing in a theme hides nothing there", () => {
  const style = darkRules(`rect[fill="#777777"]{fill:none}`);
  const out = issuesOf(
    doc(
      `<circle cx="50" cy="50" r="2" fill="#000000"/><rect x="40" y="40" width="20" height="20" fill="#777777"/>`,
      { style },
    ),
  );
  has(out, /^light: circle fill is covered by a rect/);
  assert.ok(
    !out.some((i) => /^dark: circle fill is covered/.test(i)),
    String(out),
  );
});

// ---- review: a full-canvas rect drawn after content is not the page ---------------------------

test("PAGE a full-canvas rect drawn after a mark is not the page: the page under the mark is assumed", () => {
  const out = audit(
    svg({
      style: "",
      bg: "",
      body: `<line x1="10" y1="50" x2="90" y2="50" stroke="#000000"/>${CANVAS("#ffffff")}`,
    }),
  );
  has([...out], /^light: line stroke is covered by a rect drawn after it/);
  has([...out], /^light: rect fill #ffffff at 1\.00:1 \(marks need 3:1\)/);
  assert.ok(
    out.notes.some((n) => /no background rect/.test(n)),
    JSON.stringify(out.notes),
  );
});
test("PAGE a canvas rect drawn first is still the page, in the theme where it paints", () => {
  const out = audit(svg({ style: "", bg: CANVAS("#ffffff"), body: "" }));
  assert.deepEqual([...out], []);
  assert.deepEqual(out.notes, []);
});

// ---- review: a bordered chip with text inside is a figure box ----------------------------------

test("CHIP a bordered 20px chip with text inside holds the figure-box floor", () => {
  for (const [w, h] of [
    [60, 20],
    [30, 16],
  ])
    has(
      issuesOf(
        doc(
          `<rect x="10" y="40" width="${w}" height="${h}" fill="#f3f6fb" stroke="#1c2330"/><text x="13" y="${40 + h - 4}" font-size="10" fill="#1c2330">ab</text>`,
        ),
      ),
      /^"ab" is 10px inside a figure box \(floor 11px\)/,
    );
});
test("CHIP an unstroked cell with text inside is not a figure box", () => {
  none(
    doc(
      `<rect x="10" y="40" width="60" height="20" fill="#f3f6fb"/><text x="13" y="56" font-size="10" fill="#1c2330">ab</text>`,
    ),
  );
});

// ---- sweep: a page-coloured stroke has no exemption --------------------------------------------

test("STROKE a white stroke-only polyline on the white page fails, with or without a fill under it", () => {
  has(
    issuesOf(
      doc(
        `<polyline points="10,10 50,50 90,10" fill="none" stroke="#ffffff"/>`,
      ),
    ),
    /^light: polyline stroke #ffffff at 1\.00:1/,
  );
  has(
    issuesOf(
      doc(
        `<circle cx="50" cy="50" r="6" fill="#000000" stroke="#ffffff" stroke-width="2"/>`,
      ),
    ),
    /^light: circle stroke #ffffff at 1\.00:1/,
  );
});

// ---- sweep: a dark rule may set a property other than its selector's attribute ------------------

test("DARK a rule selecting on fill that sets stroke recolours the stroke (CSS attribute selector)", () => {
  const dot = `<circle cx="50" cy="50" r="6" fill="#808080" stroke="#000000" stroke-width="2"/>`;
  const page = `rect[fill="#ffffff"]{fill:#0d1117}`;
  has(
    issuesOf(doc(dot, { style: darkRules(page) })),
    /^dark: circle stroke #000000 at/,
  );
  none(
    doc(dot, {
      style: darkRules(`${page}circle[fill="#808080"]{stroke:#e2e7ec}`),
    }),
  );
});

// ---- review: the grid exemption needs a hairline: one straight segment at most 1px wide -------

const GRID_DARK = (line = "#21262d", more = "") =>
  darkRules(
    `rect[fill="#ffffff"]{fill:#0d1117}line[stroke="#e4e8ec"]{stroke:${line}}path[stroke="#e4e8ec"]{stroke:${line}}polyline[stroke="#e4e8ec"]{stroke:${line}}${more}`,
  );
const gridIssues = (body, style = GRID_DARK()) =>
  issuesOf(doc(body, { w: 200, h: 100, style }));
test("GRID a 10px line, path or polyline in the grid colour is a mark in both themes", () => {
  for (const [tag, el] of [
    ["line", `<line x1="0" y1="50" x2="200" y2="50"`],
    ["path", `<path d="M0 50H200" fill="none"`],
    ["polyline", `<polyline points="0,50 200,50" fill="none"`],
  ]) {
    const out = gridIssues(`${el} stroke="#e4e8ec" stroke-width="10"/>`);
    has(out, new RegExp(`^light: ${tag} stroke #e4e8ec at 1\\.23:1`));
    has(out, new RegExp(`^dark: ${tag} stroke #21262d at 1\\.24:1`));
  }
});
test("GRID a 1.5px grid-colour line is a mark; 1px, 0.5px and the default width are hairlines", () => {
  has(
    gridIssues(
      `<line x1="0" y1="50" x2="200" y2="50" stroke="#e4e8ec" stroke-width="1.5"/>`,
    ),
    /^light: line stroke #e4e8ec at 1\.23:1/,
  );
  for (const w of [``, ` stroke-width="1"`, ` stroke-width="0.5"`])
    assert.deepEqual(
      gridIssues(
        `<line x1="0" y1="50" x2="200" y2="50" stroke="#e4e8ec"${w}/><line x1="100" y1="0" x2="100" y2="100" stroke="#e4e8ec"${w}/><path d="M0 60H200" fill="none" stroke="#e4e8ec"${w}/><path d="M120 0V100" fill="none" stroke="#e4e8ec"${w}/><polyline points="0,70 200,70" fill="none" stroke="#e4e8ec"${w}/>`,
      ),
      [],
    );
});
test("GRID a diagonal line, a bent path, two segments in one path and a closed path are marks", () => {
  for (const [tag, el] of [
    ["line", `<line x1="0" y1="0" x2="200" y2="100"`],
    ["path", `<path d="M0 50H100V90" fill="none"`],
    ["path", `<path d="M0 50H200M0 60H200" fill="none"`],
    ["path", `<path d="M0 50H200Z" fill="none"`],
    ["polyline", `<polyline points="0,50 100,50 200,50" fill="none"`],
  ]) {
    const out = gridIssues(`${el} stroke="#e4e8ec"/>`);
    has(out, new RegExp(`^light: ${tag} stroke #e4e8ec at 1\\.23:1`));
    has(out, new RegExp(`^dark: ${tag} stroke #21262d at 1\\.24:1`));
  }
});
test("GRID a 10px grid-colour line under a text is its backdrop in both themes; a hairline is not", () => {
  const style = GRID_DARK("#6e7681", `text[fill="#6b7885"]{fill:#8b949e}`);
  const under = (w) =>
    `<line x1="30" y1="0" x2="30" y2="100" stroke="#e4e8ec" stroke-width="${w}"/><text x="10" y="30" font-size="12" fill="#6b7885">label</text>`;
  const out = gridIssues(under(10), style);
  has(out, /^light: "label" #6b7885 at 3\.\d\d:1/);
  has(out, /^dark: "label" #8b949e at 1\.\d\d:1/);
  assert.deepEqual(gridIssues(under(1), style), []);
});

// ---- review: one fill geometry per shape kind, read by every predicate ----------------------------

// a square rect, a rounded rect (rx 60), a circle and an outline-only rect over 20..180 of a
// 200x200 canvas; on the canvas, one covering it (the rounded one with rx 20, the circle
// r 142 around the centre)
const KINDS = ["square", "rounded", "circle", "outline"];
const THEMES_T = ["light", "dark"];
const KTAG = {
  square: "rect",
  rounded: "rect",
  circle: "circle",
  outline: "rect",
};
const FILLED = new Set(["square", "rounded", "circle"]);
const shapeKind = (kind, c, { canvas = false, stroke = null } = {}) => {
  const paint =
    kind === "outline"
      ? `fill="none" stroke="${stroke ?? c}" stroke-width="2"`
      : `fill="${c}"${stroke ? ` stroke="${stroke}" stroke-width="2"` : ""}`;
  if (kind === "circle")
    return `<circle cx="100" cy="100" r="${canvas ? 142 : 80}" ${paint}/>`;
  const [at, size] = canvas ? [0, 200] : [20, 160];
  const rx = kind === "rounded" ? ` rx="${canvas ? 20 : 60}"` : "";
  return `<rect x="${at}" y="${at}" width="${size}" height="${size}"${rx} ${paint}/>`;
};
// ink and a faint tint (under 3:1 on the page) in each theme
const INK = { light: "#333333", dark: "#cccccc" };
const FAINT = { light: "#eeeeee", dark: "#161b22" };
const KIND_DARK = darkRules(
  `rect[fill="#ffffff"]{fill:#0d1117}` +
    ["rect", "circle", "text"]
      .map((t) => `${t}[fill="#333333"]{fill:#cccccc}`)
      .join("") +
    ["rect", "circle"]
      .map(
        (t) =>
          `${t}[stroke="#333333"]{stroke:#cccccc}${t}[fill="#eeeeee"]{fill:#161b22}${t}[stroke="#eeeeee"]{stroke:#161b22}`,
      )
      .join(""),
);
const kindDoc = (body, { page = true, style = KIND_DARK } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" ${FONT}><style>${style}</style>${page ? `<rect width="200" height="200" fill="#ffffff"/>` : ""}${body}</svg>`;
const txt = (s, x, y, fill, size = 12) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${s}</text>`;
const dot = (x, y, r, fill) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// the issues of one theme, its prefix removed
const inTheme = (out, theme) =>
  out
    .filter((i) => i.startsWith(`${theme}: `))
    .map((i) => i.slice(theme.length + 2));
const expectIn = (out, theme, re, want) =>
  assert.equal(
    inTheme(out, theme).some((i) => re.test(i)),
    want,
    `${want ? "no" : "an"} ${theme} issue matching ${re} in ${JSON.stringify([...out])}`,
  );

// predicate -> (kind, theme) -> check; the comment on each names what it pins
const MATRIX = {
  // page selection: a fill that covers the whole canvas (a rounded rect leaves its corners)
  page: (kind, theme) => {
    const out = audit(
      kindDoc(shapeKind(kind, FAINT.light, { canvas: true }), { page: false }),
    );
    const isPage = kind === "square" || kind === "circle";
    const ch = kind === "outline" ? "stroke" : "fill";
    expectIn(
      out,
      theme,
      new RegExp(`^${KTAG[kind]} ${ch} ${reEsc(FAINT[theme])} at`),
      !isPage,
    );
    assert.equal(
      out.notes.some((n) => /no background rect/.test(n)),
      !isPage,
      JSON.stringify(out.notes),
    );
  },
  // a shape frames a text whose anchor is inside its area: centre
  "frames text (centre)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(shapeKind(kind, FAINT.light) + txt("x", 100, 104, INK.light)),
    );
    expectIn(out, theme, /^(rect|circle) (fill|stroke)/, false);
    expectIn(out, theme, /cannot verify/, false);
  },
  // ... and not one anchored in a clipped corner of its box
  "frames text (corner)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(shapeKind(kind, FAINT.light) + txt("x", 23, 30, INK.light)),
    );
    const framed = kind === "square" || kind === "outline";
    expectIn(
      out,
      theme,
      new RegExp(`^${KTAG[kind]} fill ${reEsc(FAINT[theme])} at`),
      !framed,
    );
  },
  // a text's backdrop: same-coloured text inside a filled shape fails at 1:1
  "text backdrop": (kind, theme) => {
    const out = issuesOf(
      kindDoc(shapeKind(kind, INK.light) + txt("x", 100, 104, INK.light)),
    );
    expectIn(
      out,
      theme,
      new RegExp(`^"x" ${reEsc(INK[theme])} at 1\\.00:1`),
      FILLED.has(kind),
    );
    expectIn(out, theme, /cannot verify/, false);
  },
  // a mark's backdrop: a same-coloured smaller dot inside a filled shape fails at 1:1
  "mark backdrop": (kind, theme) => {
    const out = issuesOf(
      kindDoc(shapeKind(kind, INK.light) + dot(100, 100, 4, INK.light)),
    );
    expectIn(
      out,
      theme,
      new RegExp(`^circle fill ${reEsc(INK[theme])} at 1\\.00:1`),
      FILLED.has(kind),
    );
    expectIn(out, theme, /cannot verify/, false);
  },
  // collisions: a text or dot in a corner of the box outside a rounded rect or circle is on
  // the page, not on the shape
  "collision (text in a corner)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(shapeKind(kind, INK.light) + txt("x", 23, 34, INK.light, 10)),
    );
    expectIn(out, theme, /^"x" #\w+ at/, kind === "square");
    expectIn(out, theme, /cannot verify/, false);
  },
  "collision (dot in a corner)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(shapeKind(kind, INK.light) + dot(26, 26, 2, INK.light)),
    );
    expectIn(
      out,
      theme,
      new RegExp(`^circle fill ${reEsc(INK[theme])} at 1\\.00:1`),
      kind === "square",
    );
    expectIn(out, theme, /cannot verify/, false);
  },
  // covers: a shape drawn after a text or dot paints over it where its area reaches
  "covers (text at the centre)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(txt("x", 100, 104, INK.light) + shapeKind(kind, FAINT.light)),
    );
    expectIn(out, theme, /^"x" is covered by/, FILLED.has(kind));
  },
  "covers (dot at the centre)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(dot(100, 100, 4, INK.light) + shapeKind(kind, FAINT.light)),
    );
    expectIn(out, theme, /^circle fill is covered by/, FILLED.has(kind));
  },
  "covers (dot in a corner)": (kind, theme) => {
    const out = issuesOf(
      kindDoc(dot(26, 26, 2, INK.light) + shapeKind(kind, FAINT.light)),
    );
    expectIn(out, theme, /^circle fill is covered by/, kind === "square");
  },
};
for (const [pred, check] of Object.entries(MATRIX))
  for (const kind of KINDS)
    for (const theme of THEMES_T)
      test(`GEOM ${pred} x ${kind} (${theme})`, () => check(kind, theme));

// figure-box classification, per theme: the stroke paints in that theme only. A 9px text
// inside a stroked container (filled or outline only) gets the box floor; one in a clipped
// corner is outside it
const BOX_STYLE = {
  light: [
    "#555555",
    ["rect", "circle"].map((t) => `${t}[stroke="#555555"]{stroke:none}`),
  ],
  dark: [
    "none",
    ["rect", "circle"].map((t) => `${t}[stroke="none"]{stroke:#cccccc}`),
  ],
};
for (const [where, x, y] of [
  ["centre", 100, 104],
  ["corner", 23, 30],
])
  for (const kind of KINDS)
    for (const theme of THEMES_T)
      test(`GEOM figure box (${where}) x ${kind} (${theme})`, () => {
        const [stroke, rules] = BOX_STYLE[theme];
        const style = KIND_DARK.replace(/\}$/, `${rules.join("")}}`);
        const out = issuesOf(
          kindDoc(
            shapeKind(kind, FAINT.light, { stroke }) +
              txt("x", x, y, INK.light, 9),
            { style },
          ),
        );
        const want =
          where === "centre" || kind === "square" || kind === "outline";
        const other = theme === "light" ? "dark" : "light";
        const floor = /^"x" is 9px inside a figure box \(floor 11px\)/;
        const own = theme === "light" ? out : inTheme(out, "dark");
        assert.equal(
          own.some((i) => floor.test(i)),
          want,
          JSON.stringify(out),
        );
        const rest = other === "light" ? out : inTheme(out, "dark");
        assert.ok(!rest.some((i) => floor.test(i)), JSON.stringify(out));
      });

test("GEOM a canvas-sized rect with rx=20 is not the page: its corners show the page under it", () => {
  const out = audit(
    kindDoc(
      `<rect width="200" height="200" rx="20" fill="#eeeeee"/>${txt("x", 100, 104, INK.light)}`,
      { page: false },
    ),
  );
  assert.ok(
    out.notes.some((n) => /no background rect/.test(n)),
    JSON.stringify(out.notes),
  );
});
test("GEOM white text entering a rounded rect's clipped corner is not framed by it", () => {
  // white text on the dark page in dark, black in light; the rect is a faint tint
  const style = KIND_DARK.replace(/\}$/, `text[fill="#000000"]{fill:#ffffff}}`);
  const out = issuesOf(
    kindDoc(
      `<rect x="20" y="20" width="160" height="160" rx="60" fill="#eeeeee"/>${txt("x", 23, 30, "#000000")}`,
      { style },
    ),
  );
  has(out, /^dark: rect fill #161b22 at 1\.\d\d:1/);
  has(out, /^light: rect fill #eeeeee at 1\.\d\d:1/);
});
test("GEOM a 9px text inside a fill=none bordered rect gets the box floor", () => {
  has(
    issuesOf(
      kindDoc(
        `<rect x="20" y="20" width="160" height="160" fill="none" stroke="#333333"/>${txt("x", 100, 104, INK.light, 9)}`,
      ),
    ),
    /^"x" is 9px inside a figure box \(floor 11px\)/,
  );
});
test("GEOM white text whose glyphs all lie inside a dark circle, near its arc, passes in both themes", () => {
  // the tall glyph in the middle sets the text's box; the short ones at the ends sit
  // inside the arc where that box's top corners do not
  const style = darkRules(
    `rect[fill="#ffffff"]{fill:#0d1117}circle[fill="#222222"]{fill:#dddddd}text[fill="#ffffff"]{fill:#000000}`,
  );
  none(
    kindDoc(
      `<circle cx="100" cy="100" r="80" fill="#222222"/><text x="100" y="38" font-size="12" text-anchor="middle" fill="#ffffff">ooooolooooo</text>`,
      { style },
    ),
  );
  // the same text moved up through the arc onto the page fails
  has(
    issuesOf(
      kindDoc(
        `<circle cx="100" cy="100" r="80" fill="#222222"/><text x="100" y="24" font-size="12" text-anchor="middle" fill="#ffffff">ooooolooooo</text>`,
        { style },
      ),
    ),
    /^light: "ooooolooooo" #ffffff at 1\.00:1/,
  );
});
test("GEOM a rect whose rx clamps unequally (elliptical corners) strokes over a dot 1.84px inside its end", () => {
  // x=20 w=160 h=10 rx=30: rx 30, ry 5. The point (22.5, 55) lies 1.84px from the edge,
  // under the 4px stroke, and inside the ellipse with radii rx-2 and ry-2
  const body = `<rect x="20" y="50" width="160" height="10" rx="30" fill="#ffffff" stroke="#000000" stroke-width="4"/><text x="22.5" y="55.1" font-size="0.5" text-anchor="middle" fill="#000000">.</text>`;
  const style = darkRules(
    `rect[fill="#ffffff"]{fill:#0d1117}text[fill="#000000"]{fill:#ffffff}rect[stroke="#000000"]{stroke:#ffffff}`,
  );
  const out = issuesOf(doc(body, { w: 200, h: 100, style }), {
    minText: 0,
    minBoxText: 0,
  });
  has(out, /^light: "\." #000000 at 1\.00:1/);
  has(out, /^dark: "\." #ffffff at 1\.00:1/);
});

// ---- review: a mark's cover is tested against its painted stroke, not its reach box -------------

test("COVER a butt-capped line under a later rect of exactly its band is covered", () => {
  // the band of a 2px line (10,50)-(90,50) with butt caps is x 10..90, y 49..51
  const line = `<line x1="10" y1="50" x2="90" y2="50" stroke="#000000" stroke-width="2"/>`;
  const out = issuesOf(
    doc(line + `<rect x="10" y="49" width="80" height="2" fill="#777777"/>`),
  );
  has(
    out,
    /^light: line stroke is covered by a rect drawn after it \(fill #777777\)/,
  );
  has(
    out,
    /^dark: line stroke is covered by a rect drawn after it \(fill #777777\)/,
  );
});
test("COVER a round or square cap reaches past the rect: the same segment is not covered", () => {
  for (const cap of ["round", "square"]) {
    const out = issuesOf(
      doc(
        `<polyline points="10,50 90,50" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="${cap}"/><rect x="10" y="49" width="80" height="2" fill="#777777"/>`,
      ),
    );
    assert.deepEqual(out, [], cap);
  }
  // a rect over the caps as well covers it
  has(
    issuesOf(
      doc(
        `<polyline points="10,50 90,50" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="square"/><rect x="9" y="49" width="82" height="2" fill="#777777"/>`,
      ),
    ),
    /^light: polyline stroke is covered by a rect/,
  );
});
test("COVER a join counts only at a vertex: a bent polyline is covered when its join's reach is", () => {
  // two 2px segments meeting at (50,50); the miter join reaches 4px around the vertex
  const bent = `<polyline points="10,50 50,50 50,90" fill="none" stroke="#000000" stroke-width="2"/>`;
  has(
    issuesOf(
      doc(bent + `<rect x="10" y="46" width="44" height="44" fill="#777777"/>`),
    ),
    /^light: polyline stroke is covered by a rect drawn after it/,
  );
  // the bands alone, without the join's reach, are not taken as covered
  none(
    doc(bent + `<rect x="10" y="49" width="41" height="41" fill="#777777"/>`),
  );
});
