#!/usr/bin/env node
// Tests for svg-audit.mjs. Run: node test-svg-audit.mjs   (exit 1 on any failure)
// Fixtures are written to a temp directory that is removed at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./svg-audit.mjs", import.meta.url));
const { auditSvg } = await import(SCRIPT);
const tmp = mkdtempSync(join(tmpdir(), "svg-audit-test-"));

let failed = 0;
let ran = 0;
const test = (name, fn) => {
  ran++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`);
  }
};
const cli = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
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
  const bad = join(tmp, "f1-bad.svg");
  writeFileSync(bad, svg({ body: text("pale", `fill="#cccccc"`) }));
  const link = join(tmp, "audit-link.mjs");
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, [link, bad], { encoding: "utf8" });
  assert.equal(
    r.status,
    1,
    `exit ${r.status}, stdout ${JSON.stringify(r.stdout)}`,
  );
  assert.match(r.stdout, /FAIL/);
});

test("F1 CLI through a symlink passes a clean chart with output", () => {
  const good = join(tmp, "f1-good.svg");
  writeFileSync(good, svg({ body: text("fine") }));
  const link = join(tmp, "audit-link2.mjs");
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, [link, good], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok /);
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
  has([...out], /^dark: "y" \(default black\)/);
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
test("F4 font-size in pt and em is converted", () => {
  const body =
    `<text x="10" y="20" font-size="6pt" fill="#1c2330">pt</text>` +
    `<g font-size="10"><text x="10" y="40" font-size="0.5em" fill="#1c2330">em</text></g>`;
  const out = issuesOf(svg({ body }));
  has(out, /"pt" is 8px/);
  has(out, /"em" is 5px/);
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
  has(out, /^dark: "bare" \(default black\)/);
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

// ---- CLI -----------------------------------------------------------------------------------------------------------

test("CLI --grid-color changes the hairline exemption", () => {
  const f = join(tmp, "grid.svg");
  writeFileSync(
    f,
    svg({ body: `<line x1="0" y1="50" x2="100" y2="50" stroke="#f0f0f0"/>` }),
  );
  assert.equal(cli(f).status, 1);
  assert.equal(cli("--grid-color", "#f0f0f0", f).status, 0);
});
test("CLI --min-text sets the floor and a non-number is a usage error", () => {
  const f = join(tmp, "floor.svg");
  writeFileSync(
    f,
    svg({ body: `<text x="10" y="20" font-size="10" fill="#1c2330">t</text>` }),
  );
  assert.equal(cli(f).status, 0);
  assert.equal(cli("--min-text", "11", f).status, 1);
  assert.equal(cli("--min-text", "abc", f).status, 2);
});
test("CLI exits 2 with no files, an unknown flag, or an unreadable file", () => {
  assert.equal(cli().status, 2);
  assert.equal(cli("--bogus", "x.svg").status, 2);
  assert.equal(cli(join(tmp, "missing.svg")).status, 2);
});
test("CLI prints notes next to an ok result", () => {
  const f = join(tmp, "nobg.svg");
  writeFileSync(
    f,
    svg({ bg: "", style: "", body: text("y", `fill="#000000"`) }),
  );
  const r = cli(f);
  assert.equal(r.status, 1); // black text on the assumed #0d1117 dark page
  assert.match(r.stdout, /note: no background rect/);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
