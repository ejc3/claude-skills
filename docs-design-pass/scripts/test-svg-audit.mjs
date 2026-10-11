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

const DARK = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#e2e7ec}}`;
const BG_ONLY = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}}`;
const BG = `<rect width="200" height="100" fill="#ffffff"/>`;
const svg = ({
  style = DARK,
  bg = BG,
  body = "",
  head = `width="200" height="100" viewBox="0 0 200 100"`,
}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${head}>\n<style>${style}</style>\n${bg}\n${body}\n</svg>`;
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
      fill: #1c2330; /* text left dark on a dark page */
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
    /unsupported selector "text".*outside/,
  );
});
test("F2 another @media block is reported", () => {
  const style = `@media (max-width: 400px){text{font-size:8px}}`;
  has(
    issuesOf(svg({ style, body: text("x") })),
    /unsupported "@media \(max-width: 400px\)"/,
  );
});

test("F2 an @import is reported, alone or ahead of a rule", () => {
  has(
    issuesOf(svg({ style: `@import url(x.css);`, body: text("x") })),
    /unsupported "@import url\(x\.css\);"/,
  );
  has(
    issuesOf(
      svg({ style: `@import url(x.css); text{fill:#000}`, body: text("x") }),
    ),
    /unsupported "@import url\(x\.css\); text"/,
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
test("F3 an SVG with only a viewBox and a 100% background rect is audited", () => {
  const out = audit(
    svg({
      style: BG_ONLY,
      head: `viewBox="0 0 200 100"`,
      bg: `<rect width="100%" height="100%" fill="#ffffff"/>`,
      body: text("x"),
    }),
  );
  has([...out], /^dark: "x"/);
  assert.deepEqual(out.notes, []);
});
test("F3 width=100% with a viewBox and a numeric background rect is audited", () => {
  const out = audit(
    svg({
      style: BG_ONLY,
      head: `width="100%" viewBox="0 0 200 100"`,
      body: text("x"),
    }),
  );
  has([...out], /^dark: "x"/);
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

test("F4 font-size with px units is checked", () => {
  has(
    issuesOf(
      svg({
        body: `<text x="10" y="20" font-size="8px" fill="#1c2330">tiny</text>`,
      }),
    ),
    /"tiny" is 8px/,
  );
});
test("F4 font-size in any unit but px, and keywords, are reported as unreadable", () => {
  const sizes = ["6pt", "0.5em", "50%", "small", "1rem"];
  const body = sizes
    .map(
      (v, i) =>
        `<text x="10" y="${20 + i * 20}" font-size="${v}" fill="#1c2330">u${i}</text>`,
    )
    .join("");
  const out = issuesOf(svg({ body }));
  sizes.forEach((v, i) =>
    has(
      out,
      new RegExp(
        `^"u${i}" has a font-size the audit cannot read \\(${v.replace(".", "\\.")}\\)`,
      ),
    ),
  );
});
test("F4 a unitless font-size and a style-attribute px size are read", () => {
  const body =
    `<text x="10" y="20" font-size="7.5" fill="#1c2330">bare</text>` +
    `<text x="10" y="40" style="font-size:6px" fill="#1c2330">css</text>`;
  const out = issuesOf(svg({ body }));
  has(out, /"bare" is 7\.5px/);
  has(out, /"css" is 6px/);
});
test("F4 a dark rule that shrinks the font-size is audited in the dark theme", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#e2e7ec;font-size:7px}}`;
  const out = issuesOf(svg({ style, body: text("x") }));
  assert.deepEqual(out, [`dark: "x" is 7px (floor 9px)`]);
});
test("F4 a dark rule with an unreadable font-size is reported", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}text[fill="#1c2330"]{fill:#e2e7ec;font-size:1em}}`;
  has(
    issuesOf(svg({ style, body: text("x") })),
    /^dark: "x" has a font-size the audit cannot read \(1em\)/,
  );
});
test("F4 an unreadable font-size is reported, not passed", () => {
  has(
    issuesOf(
      svg({
        body: `<text x="10" y="20" font-size="calc(1px+2px)" fill="#1c2330">odd</text>`,
      }),
    ),
    /"odd".*font-size/,
  );
});
test("F4 font-size inherited from a <g> is checked", () => {
  has(
    issuesOf(
      svg({
        body: `<g font-size="8"><text x="10" y="20" fill="#1c2330">small</text></g>`,
      }),
    ),
    /"small" is 8px/,
  );
});
test("F4 fill inherited from a <g> is checked", () => {
  const body = `<g fill="#cccccc"><text x="10" y="20" font-size="12">pale</text></g>`;
  has(issuesOf(svg({ body })), /^light: "pale" #cccccc/);
});
test("F4 a dark rule on the <g> recolours an inheriting text", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}g[fill="#1c2330"]{fill:#e2e7ec}}`;
  const body = `<g fill="#1c2330"><text x="10" y="20" font-size="12">ink</text></g>`;
  assert.deepEqual(issuesOf(svg({ style, body })), []);
});
test("F4 <tspan> text is audited for size and contrast", () => {
  const body =
    `<text x="10" y="20" font-size="12" fill="#1c2330">label ` +
    `<tspan fill="#cccccc">pale</tspan><tspan font-size="7">tiny</tspan></text>`;
  const out = issuesOf(svg({ body }));
  has(out, /^light: "pale" #cccccc/);
  has(out, /"tiny" is 7px/);
});
test("F4 text without a fill is black in both themes, so it fails on the dark page", () => {
  const out = issuesOf(svg({ body: text("bare", "") }));
  assert.ok(!out.some((i) => /^light:/.test(i)), JSON.stringify(out));
  has(out, /^dark: "bare" black at/);
});
test("F4 fill:none text draws nothing and is not flagged", () => {
  assert.deepEqual(issuesOf(svg({ body: text("ghost", `fill="none"`) })), []);
});
test("F4 an unreadable fill on text is reported", () => {
  has(
    issuesOf(svg({ body: text("grad", `fill="url(#g)"`) })),
    /"grad" has a fill the audit cannot read/,
  );
});
test("F4 style attribute and entities in text are read", () => {
  const body = `<text x="10" y="20" style="font-size:8px;fill:#cccccc">a &amp; b</text>`;
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
test("F6 stroke inherited from a <g> is checked", () => {
  has(
    marks(`<g stroke="#dddddd"><line x1="0" y1="50" x2="100" y2="50"/></g>`),
    /^light: line stroke #dddddd/,
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

test("F8 a translucent near-white bar on white is flagged", () => {
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
    /^light: rect fill #dddddd \(50% opaque\)/,
  );
});
test("F8 a stroke-opacity 0.5 pale series line is flagged", () => {
  has(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="#aaaaaa" stroke-opacity="0.5"/>`,
    ),
    /^light: line stroke #aaaaaa \(50% opaque\) at/,
  );
});
test("F8 a line inside a group with opacity 0.3 is flagged", () => {
  has(
    marks(
      `<g opacity="0.3"><line x1="0" y1="50" x2="100" y2="50" stroke="#555555"/></g>`,
    ),
    /^light: line stroke #555555 \(30% opaque\) at/,
  );
});
test("F8 a translucent mark that still reaches 3:1 passes", () => {
  assert.deepEqual(
    marks(
      `<line x1="0" y1="50" x2="100" y2="50" stroke="#000000" stroke-opacity="0.8"/>`,
      undefined,
      { style: "" },
    ),
    [],
  );
});
test("F8 a translucent mark is composited over each theme's own page", () => {
  const style = `@media (prefers-color-scheme: dark){rect[fill="#ffffff"]{fill:#0d1117}}`;
  const out = marks(
    `<line x1="0" y1="50" x2="100" y2="50" stroke="#cccccc" stroke-opacity="0.5"/>`,
    undefined,
    { style },
  );
  has(out, /^light: line stroke #cccccc \(50% opaque\)/);
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
test("F7 an inherited fill overrides the initial value", () => {
  assert.deepEqual(
    marks(`<g fill="none"><circle cx="20" cy="70" r="4"/></g>`),
    [],
  );
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
  const r = cli("--grid-color", "blue", f);
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
