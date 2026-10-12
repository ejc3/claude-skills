#!/usr/bin/env node
// Tests for linkcheck.mjs. Run: node test-linkcheck.mjs   (exit 1 on any failure)
// Each case builds a throwaway git repository in a temp directory that is removed at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./linkcheck.mjs", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "linkcheck-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
// a fresh directory holding `files`
const plain = (files) => {
  const dir = join(tmp, `dir${n++}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
};
// the same, as a git repository
const repo = (files) => {
  const dir = plain({});
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
};
const run = (cwd, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
// run the CLI through a symlink to the script, as an installed skill is
const viaLink = (cwd, ...args) => {
  const link = join(tmp, `linkcheck-link${n++}.mjs`);
  symlinkSync(SCRIPT, link);
  return spawnSync(process.execPath, [link, ...args], {
    cwd,
    encoding: "utf8",
  });
};
// check a.md in a repo that also holds `others`
const check = (a, others = {}, file = "a.md") =>
  run(repo({ "a.md": a, ...others }), file);
const expectExit = (r, status, stdout) => {
  assert.equal(r.status, status, r.stdout + r.stderr);
  if (stdout) assert.match(r.stdout, stdout);
};
const summary = (r) => /checked (\d+) links, (\d+) broken/.exec(r.stdout);
const expectClean = (r, links) => {
  expectExit(r, 0);
  const m = summary(r);
  assert.ok(m, r.stdout);
  if (links !== undefined) assert.equal(+m[1], links, r.stdout);
};
const expectBroken = (r, count, re) => {
  expectExit(r, 1, re);
  assert.equal(+summary(r)?.[2], count, r.stdout + r.stderr);
};

// ---- baseline behaviour --------------------------------------------------------------------------

test("control: relative file and anchor links resolve", () => {
  expectClean(
    check("[b](b.md) [s](b.md#section-one) [self](#top)\n\n# Top\n", {
      "b.md": "## Section One\n",
    }),
    3,
  );
});
test("control: a missing file and a missing anchor are reported", () => {
  const r = check("[b](nope.md)\n[c](b.md#nope)\n", { "b.md": "# B\n" });
  expectBroken(r, 2, /a\.md:1: missing file nope\.md/);
  assert.match(r.stdout, /a\.md:2: missing anchor b\.md#nope/);
});
test("control: external links, code spans and ``` or ~~~ fences are skipped", () => {
  expectClean(
    check(
      "[x](https://example.com/none) `[y](nope.md)`\n```\n[z](nope.md)\n```\n~~~\n[w](nope.md)\n~~~\n",
    ),
    0,
  );
});
test("control: duplicate headings get -1, -2 suffixes", () => {
  expectClean(check("[1](#a) [2](#a-1) [3](#a-2)\n\n# A\n# A\n# A\n"), 3);
});
test("control: <a name> and id= anchors count", () => {
  expectClean(
    check(
      '[x](#here) [y](#there)\n\n<a name="here"></a>\n<div id="there"></div>\n',
    ),
    2,
  );
});

// ---- finding 9: root-relative links ---------------------------------------------------------------------

test("F9 /path links resolve against the git top-level", () => {
  const dir = repo({
    "docs/sub/a.md": "[x](/docs/x.md) [h](/docs/x.md#heading)\n",
    "docs/x.md": "# Heading\n",
  });
  expectClean(run(dir, "docs/sub/a.md"), 2);
});
test("control: a missing /path target is reported", () => {
  const dir = repo({
    "docs/a.md": "[x](/docs/nope.md)\n",
    "docs/x.md": "# H\n",
  });
  expectBroken(run(dir, "docs/a.md"), 1, /missing file \/docs\/nope\.md/);
});
test("F9 a /path link outside a git repository is reported, not resolved at /", () => {
  const dir = plain({ "a.md": "[x](/etc/hostname)\n" });
  expectBroken(run(dir, "a.md"), 1, /not in a git repository/);
});

// ---- finding 9: link titles -----------------------------------------------------------------------------------

test("F9 links with titles are parsed and checked", () => {
  const r = check(
    `[a](b.md "title") [b](b.md 'title') [c](b.md (title)) [d](b.md#s "t")\n`,
    { "b.md": "# S\n" },
  );
  expectClean(r, 4);
});
test("F9 a broken link with a title is reported", () => {
  const r = check(`[a](nope.md "the title")\n[b](b.md#nope 'x')\n`, {
    "b.md": "# S\n",
  });
  expectBroken(r, 2, /missing file nope\.md/);
});
test("F9 angle-bracket destinations and balanced parentheses are parsed", () => {
  const r = check("[a](<my file.md>) [b](f_(x).md)\n", {
    "my file.md": "x\n",
    "f_(x).md": "x\n",
  });
  expectClean(r, 2);
});
test("F9 reference definitions are checked", () => {
  const r = check("[a][ref]\n\n[ref]: nope.md\n[ok]: b.md\n", {
    "b.md": "x\n",
  });
  expectBroken(r, 1, /a\.md:3: missing file nope\.md/);
});

// ---- finding 9: setext headings ---------------------------------------------------------------------------------

test("F9 setext headings (=== and ---) produce anchors", () => {
  const r = check(
    "[a](b.md#first-title) [b](b.md#second-title) [c](b.md#a-code)\n",
    {
      "b.md":
        "First Title\n===========\n\nintro\n\nSecond Title\n---\n\n`a` code\n---\n",
    },
  );
  expectClean(r, 3);
});
test("control: a thematic break after a blank line is not a heading", () => {
  const r = check("[a](b.md#intro)\n", { "b.md": "intro\n\n---\n\ntext\n" });
  expectBroken(r, 1, /missing anchor/);
});
test("control: a table delimiter row is not a setext underline", () => {
  const r = check("[a](b.md#col-a)\n", {
    "b.md": "col a | col b\n--- | ---\n1 | 2\n",
  });
  expectBroken(r, 1, /missing anchor/);
});

// ---- finding 9: malformed % escapes ---------------------------------------------------------------------------------

test("F9 a malformed % escape is reported as broken and checking continues", () => {
  const r = check("[a](b.md#bad%zz)\n[c](nope.md)\n[d](b.md)\n", {
    "b.md": "# S\n",
  });
  expectBroken(r, 2, /malformed % escape/);
  assert.doesNotMatch(r.stderr, /URIError/);
});
test("F9 a malformed % escape in the path is reported too", () => {
  const r = check("[a](b%.md)\n", { "b.md": "# S\n" });
  expectBroken(r, 1, /malformed % escape/);
});
test("F9 %20 in a path and %-encoded anchors resolve", () => {
  const r = check("[a](my%20file.md) [b](b.md#caf%C3%A9)\n", {
    "my file.md": "x\n",
    "b.md": "# Café\n",
  });
  expectClean(r, 2);
});

// ---- finding 9: GitHub slug rules ---------------------------------------------------------------------------------------

test("F9 emphasis markers are dropped from heading slugs", () => {
  const r = check(
    "[1](b.md#bold-text) [2](b.md#under-text) [3](b.md#it-text) [4](b.md#it2-text) [5](b.md#strike-text) [6](b.md#all-three-text)\n",
    {
      "b.md":
        "# **bold** text\n# __under__ text\n# *it* text\n# _it2_ text\n# ~~strike~~ text\n# ***all three*** text\n",
    },
  );
  expectClean(r, 6);
});
test("control: underscores inside words and code spans are kept", () => {
  const r = check(
    "[1](b.md#the-snake_case_name) [2](b.md#run-my_var-now) [3](b.md#a_b)\n",
    { "b.md": "# the snake_case_name\n# run `my_var` now\n# a\\_b\n" },
  );
  expectClean(r, 3);
});
test("control: HTML tags such as <app> and <range> are dropped, code spans kept", () => {
  const r = check(
    "[1](b.md#run--build) [2](b.md#the-app-option) [3](b.md#the--option) [4](b.md#--app-flag)\n",
    {
      "b.md":
        "# Run <app> build\n# The `<app>` option\n# The <range> option\n# `--app` flag\n",
    },
  );
  expectClean(r, 4);
});
test("control: link text and a closing # sequence are dropped from heading slugs", () => {
  const r = check("[1](b.md#see-the-docs) [2](b.md#closed)\n", {
    "b.md": "# See [the docs](https://example.com)\n## Closed ##\n",
  });
  expectClean(r, 2);
});
test("control: headings inside fenced code are not anchors", () => {
  const r = check("[1](b.md#fake)\n", { "b.md": "```\n# fake\n```\n" });
  expectBroken(r, 1, /missing anchor/);
});
test("F9 ?query and #L10 line anchors are accepted", () => {
  const r = check("[1](b.md?plain=1#L10) [2](b.md#L3-L9) [3](b.md?plain=1)\n", {
    "b.md": "# S\n",
  });
  expectClean(r, 3);
});

// ---- structure: fences, anchors, link forms ------------------------------------------------------------------

test("a fence closes only on its own marker, at least as long, with nothing after it", () => {
  const r = check(
    "[a](nope.md)\n````\n```\n[b](nope.md)\n``` text\n[c](nope.md)\n````\n~~~\n````\n[d](nope.md)\n~~~\n[e](nope.md)\n",
  );
  expectBroken(r, 2, /a\.md:1: missing file/);
  assert.match(r.stdout, /a\.md:12: missing file/);
});
test("an unclosed fence hides the rest of the file", () => {
  expectClean(check("```\n[a](nope.md)\n"), 0);
});
test("a fence between two lines breaks a setext paragraph", () => {
  const r = check("[a](b.md#para)\n", {
    "b.md": "para\n```\ncode\n```\n---\n",
  });
  expectBroken(r, 1, /missing anchor/);
});
test("an id or <a name> inside a code block is not an anchor", () => {
  const r = check("[a](b.md#fake) [b](b.md#fake2) [c](b.md#real)\n", {
    "b.md":
      '```html\n<div id="fake"></div>\n<a name="fake2"></a>\n```\n\n<span id="real"></span>\n',
  });
  expectBroken(r, 2, /missing anchor b\.md#fake\b/);
  assert.match(r.stdout, /missing anchor b\.md#fake2/);
});
test("id works on any tag, name only on <a>, and a tag split across lines is read", () => {
  const r = check("[a](b.md#i) [b](b.md#n) [c](b.md#bad) [d](b.md#multi)\n", {
    "b.md":
      '<p class="x" id="i"></p>\n<a href="#" name=\'n\'></a>\n<abbr name="bad"></abbr>\n<div\n  id="multi">\n</div>\n',
  });
  expectBroken(r, 1, /missing anchor b\.md#bad/);
});
test("a file literally named with %20 is not found by its encoded link", () => {
  const r = check("[a](my%20file.md)\n", { "my%20file.md": "x\n" });
  expectBroken(r, 1, /missing file my%20file\.md/);
});
test("a link to a directory resolves and a fragment on it is ignored", () => {
  expectClean(check("[a](docs/) [b](docs/#x)\n", { "docs/x.md": "x\n" }), 2);
});
test("underscore emphasis is dropped from slugs only when it frames the text", () => {
  const r = check(
    "[1](b.md#triple-text) [2](b.md#a_b_c) [3](b.md#_lead-and-trail_x)\n",
    { "b.md": "# ___triple___ text\n# a_b_c\n# _lead and trail_x\n" },
  );
  expectClean(r, 3);
});
test("a link title in any form and a nested parenthesis in one line", () => {
  const r = check(
    `[a](b.md "t (x)") [b](f_(x).md 'y') [c](<b.md> "t") [d](b.md  )\n`,
    { "b.md": "# S\n", "f_(x).md": "x\n" },
  );
  expectClean(r, 4);
});
test("two links on one line are both read, and an unclosed one is not", () => {
  const r = check('[a](nope.md)[b](nope2.md) [c](oops.md "t\n', {});
  expectBroken(r, 2, /missing file nope2\.md/);
});

// ---- the CLI ---------------------------------------------------------------------------------------------------------------

test("CLI runs through a symlink", () => {
  const dir = repo({ "a.md": "[x](nope.md)\n[y](a.md)\n" });
  expectBroken(viaLink(dir, "a.md"), 1, /missing file nope\.md/);
});
test("CLI with no files or an unreadable file exits 2", () => {
  const dir = repo({ "a.md": "x\n" });
  expectExit(run(dir), 2);
  expectExit(run(dir, "gone.md"), 2);
});

// ---- reference-style usages ------------------------------------------------------------------------------------

test("REF a full reference with no definition is broken", () => {
  expectBroken(
    check("see [guide][missing]\n"),
    1,
    /a\.md:1: undefined reference \[guide\]\[missing\]/,
  );
});
test("REF a collapsed reference with no definition is broken", () => {
  expectBroken(
    check("see [guide][]\n"),
    1,
    /a\.md:1: undefined reference \[guide\]\[\]/,
  );
});
test("REF labels match case-insensitively with whitespace collapsed", () => {
  expectClean(
    check(
      "[Guide][g] and [Two   words][] and [x][ TWO words ]\n\n[G]: b.md\n[two words]: b.md\n",
      {
        "b.md": "# B\n",
      },
    ),
    5,
  );
});
test("REF a defined reference whose destination is missing is reported once at the definition", () => {
  const r = check("[guide][g]\n\n[g]: nope.md\n");
  expectBroken(r, 1, /a\.md:3: missing file nope\.md/);
});
test("REF a shortcut [label] with no definition is ordinary text", () => {
  expectClean(check("an array like [a] or [1, 2] is fine\n"), 0);
});
test("REF a reference inside a code span or fence is ignored", () => {
  expectClean(check("`[x][y]` and `[z][]`\n```\n[x][y]\n```\n"), 0);
});
test("REF an image reference with no definition is broken", () => {
  expectBroken(check("![alt][img]\n"), 1, /undefined reference \[alt\]\[img\]/);
});
test("REF a definition inside a blockquote or list item counts", () => {
  expectClean(
    check("[a][r] [b][s]\n\n> [r]: b.md\n- [s]: b.md\n", { "b.md": "# B\n" }),
    4,
  );
});

// ---- indented code is not a definition ----------------------------------------------------------

test("CODE a definition in an indented code block does not define the label", () => {
  expectBroken(
    check("text\n\n    [x]: b.md\n\nsee [link][x]\n", { "b.md": "# B\n" }),
    1,
    /undefined reference \[link\]\[x\]/,
  );
  expectBroken(
    check("\t[x]: b.md\n\nsee [link][x]\n", { "b.md": "# B\n" }),
    1,
    /undefined reference \[link\]\[x\]/,
  );
});
test("CODE a definition indented 1-3 spaces still counts", () => {
  expectClean(check("see [link][x]\n\n   [x]: b.md\n", { "b.md": "# B\n" }), 2);
});
test("CODE a 4-space line that continues a paragraph is not code", () => {
  expectClean(
    check("see [link][x]\n\n[y]: b.md\n    [x]: b.md\n", { "b.md": "# B\n" }),
    3,
  );
});
test("CODE lists are not tracked: a list item's indented continuation reads as code (conservative)", () => {
  expectBroken(
    check("- item\n\n    [x]: b.md\n\nsee [link][x]\n", { "b.md": "# B\n" }),
    1,
    /undefined reference \[link\]\[x\]/,
  );
});
