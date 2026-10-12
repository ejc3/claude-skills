#!/usr/bin/env node
// Tests for numcheck.mjs. Run: node test-numcheck.mjs   (exit 1 on any failure)
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

const SCRIPT = fileURLToPath(new URL("./numcheck.mjs", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "numcheck-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
let n = 0;
const write = (dir, files) => {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
};
// a fresh directory holding `files`
const plain = (files = {}) => {
  const dir = join(tmp, `dir${n++}`);
  mkdirSync(dir);
  write(dir, files);
  return dir;
};
// a repository whose HEAD holds `files`, with `worktree` written over them uncommitted
const repo = (files, worktree = {}) => {
  const dir = plain();
  git(dir, "init", "-q");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  write(dir, worktree);
  return dir;
};
const run = (cwd, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
// run the CLI through a symlink to the script, as an installed skill is
const viaLink = (cwd, ...args) => {
  const link = join(tmp, `numcheck-link${n++}.mjs`);
  symlinkSync(SCRIPT, link);
  return spawnSync(process.execPath, [link, ...args], {
    cwd,
    encoding: "utf8",
  });
};
const expectExit = (r, status, stdout, stderr) => {
  assert.equal(r.status, status, r.stdout + r.stderr);
  if (stdout) assert.match(r.stdout, stdout);
  if (stderr) assert.match(r.stderr, stderr);
};
// numcheck HEAD doc.md after rewriting doc.md to `after`
const edit = (before, after) =>
  run(repo({ "doc.md": before }, { "doc.md": after }), "HEAD", "doc.md");

// ---- baseline behaviour ---------------------------------------------------------------------

test("control: unchanged numbers exit 0", () => {
  const r = edit("took 8.3s and 5%\n", "5% and 8.3s, reworded\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unchanged numbers/);
});
test("control: an added number exits 1 and is listed", () => {
  const r = edit("took 8s\n", "took 8s on 64 cores\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ADDED 64/);
});
test("control: a removed number is listed and exits 0", () => {
  const r = edit("took 8s on 64 cores\n", "took 8s\n");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /removed .*64/);
});
test("control: an attached unit change is caught (8.3s -> 8.3ms)", () => {
  const r = edit("took 8.3s\n", "took 8.3ms\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ADDED 8\.3ms/);
});

// ---- finding 7: units after a space and the wider unit list -------------------------------------------------

for (const [a, b] of [
  ["247 MB", "247 GB"],
  ["8.3 s", "8.3 min"],
  ["30 ms", "30 s"],
  ["12 GiB", "12 MiB"],
  ["12 MiB", "12 GiB"],
  ["2 TB", "2 GB"],
  ["15 µs", "15 ms"],
  ["3 h", "3 min"],
  ["5 min", "5 s"],
  ["500 Mbps", "500 Gbps"],
  ["1 Gbps", "1 Mbps"],
]) {
  test(`F7 "${a}" -> "${b}" reads as a changed number`, () => {
    const r = edit(`restore took ${a} here\n`, `restore took ${b} here\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /ADDED/);
  });
}
for (const [a, b] of [
  ["12GiB", "12 GiB"],
  ["8.3 s", "8.3s"],
  ["247 MB", "247 MB"],
]) {
  test(`F7 "${a}" and "${b}" are the same number`, () => {
    const r = edit(`took ${a} here\n`, `took ${b} here\n`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
test("F7 a following word is the number's unit: 3 sources -> 3 services is a change", () => {
  const r = edit("3 sources and 5 hours\n", "3 services and 5 hours\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 3services/);
});
test("F7 a space-separated unit change is listed as removed and added", () => {
  const r = edit("took 247 MB\n", "took 247 GB\n");
  assert.match(r.stdout, /ADDED 247GB/);
  assert.match(r.stdout, /removed .*247MB/);
});

// ---- the unit rule: an unlisted unit is still part of the number -----------------------------------------------

for (const [a, b, added] of [
  ["4 GHz", "4 MHz", "4MHz"],
  ["20 °C", "20 °F", "20°F"],
  ["20°C", "20°F", "20°C|20°F"],
  ["3.2 kHz", "3.2 MHz", "3.2MHz"],
  ["100 req/s", "100 req/min", "100req/min"],
  ["90 MB/s", "90 GB/s", "90GB/s"],
  ["5 files", "5 lines", "5line"],
  ["12 apps", "12 libs", "12lib"],
  ["64 cores", "64 threads", "64thread"],
  ["5 days", "5 hours", "5hour"],
  ["8 CPUs", "8 GPUs", "8GPUs"],
  ["2 Hz", "2 kHz", "2kHz"],
]) {
  test(`unit "${a}" -> "${b}" is an added number`, () => {
    const r = edit(`it ran ${a} here\n`, `it ran ${b} here\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ADDED .*(${added})`));
  });
}
for (const [a, b] of [
  ["3 sources", "3 sources"],
  ["247 MB", "247MB"],
  ["247MB", "247 MB"],
  ["4 GHz", "4GHz"],
  ["20 °C", "20 °C"],
  ["64 cores", "64-core box"],
  ["64 cores", "64 core"],
  ["1 file", "1 files"],
  ["5 days", "5-day"],
  ["10 to 20 cores", "10 to 20 cores, reworded"],
  ["5 or 6 of them", "5 or 6 of those"],
]) {
  test(`unit "${a}" and "${b}" read as the same number`, () => {
    const r = edit(`it ran ${a} here\n`, `it ran ${b} here\n`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
test("a slash after a unit is a separator: 4.5s/2.2s = 4.5s / 2.2s, 90 MB/s = 90MB/s", () => {
  assert.equal(edit("yarn 4.5s / 2.2s\n", "yarn 4.5s/2.2s\n").status, 0);
  assert.equal(edit("yarn 4.5s/2.2s\n", "yarn 4.5ms/2.2s\n").status, 1);
  assert.equal(edit("at 90 MB/s\n", "at 90MB/s\n").status, 0);
});
test("a hyphen before digits is a range; before a word it attaches the unit (10-20, 5-minute, 5-fold)", () => {
  assert.equal(edit("10-20 times\n", "10 and 20 times\n").status, 0);
  assert.equal(edit("a 5 minute wait\n", "a 5-minute wait\n").status, 0);
  // "fold" is the unit of 5, as it is in "5 fold": dropping it reads as a changed number
  assert.equal(edit("a 5-fold gain\n", "a gain of 5.\n").status, 1);
});
test("a spaced symbol alone is not a unit (10 / 20, 5 x 3)", () => {
  assert.equal(edit("10 / 20\n", "10/20\n").status, 0);
  assert.equal(edit("5 x 3\n", "5 x 3\n").status, 0);
});

// ---- a short spaced token is the number's unit unless it is a function word --------------------------------------

for (const [a, b, added] of [
  ["12 V", "12 A", "12A"],
  ["4 kg", "4 lb", "4lb"],
  ["9 Pa", "9 psi", "9psi"],
  // letters outside the BMP: the 3-letter limit counts code points, not UTF-16 units
  ["4 𝑘𝑔", "4 𝑙𝑏", "4𝑙𝑏"],
]) {
  test(`short unit "${a}" -> "${b}" is an added number`, () => {
    const r = edit(`it drew ${a} here\n`, `it drew ${b} here\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ADDED .*${added}`));
  });
}
test("a function word after a number is not a unit (3 of the apps, 5 in total)", () => {
  assert.equal(edit("3 of the apps\n", "3 of the apps\n").status, 0);
  assert.equal(edit("3 of the apps\n", "3 in the apps\n").status, 0);
  assert.equal(edit("5 in total\n", "5 at once\n").status, 0);
  assert.equal(edit("2 The end\n", "2 and end\n").status, 0);
});

// ---- finding 8: only a missing path means a new file -------------------------------------------------------------

test("F8 a bad base ref exits 2 with git's error, not 'every number is new'", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  const r = run(dir, "no-such-ref", "doc.md");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /every number is new/);
  assert.match(r.stderr, /no-such-ref/);
  assert.match(r.stderr, /fatal/);
});
test("F8 outside a git repository exits 2", () => {
  const r = run(plain({ "doc.md": "took 8s\n" }), "HEAD", "doc.md");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /every number is new/);
  assert.match(r.stderr, /not a git repository/);
});
test("F8 a file in another directory that is not in a repository exits 2", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  const other = plain({ "x.md": "8s\n" });
  const r = run(dir, "HEAD", join(other, "x.md"));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not a git repository/);
});
test("F8 a file missing on disk exits 2", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  const r = run(dir, "HEAD", "gone.md");
  assert.equal(r.status, 2, r.stdout + r.stderr);
});
test("F8 a path absent from the base ref is a new file: every number is new", () => {
  const dir = repo({ "doc.md": "took 8s\n" }, { "new.md": "took 9s\n" });
  const r = run(dir, "HEAD", "new.md");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /not in HEAD; every number is new/);
  assert.match(r.stdout, /ADDED 9s/);
});
test("F8 a new file without numbers exits 0", () => {
  const dir = repo(
    { "doc.md": "took 8s\n" },
    { "new.md": "no figures here\n" },
  );
  const r = run(dir, "HEAD", "new.md");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test("F8 a relative path from a subdirectory resolves against the repository", () => {
  const dir = repo(
    { "docs/a.md": "took 8s on 64 cores\n" },
    { "docs/a.md": "took 8s on 64 cores, reworded\n" },
  );
  const r = run(join(dir, "docs"), "HEAD", "a.md");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unchanged numbers/);
});
test("F8 an absolute path works from any directory", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  const r = run(tmp, "HEAD", join(dir, "doc.md"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---- number tokens ----------------------------------------------------------------------------------------------

test("a range reads as two numbers, not a number and a negative (10-20)", () => {
  const r = edit("took from 10 to 20 times\n", "took 10-20 times\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unchanged numbers/);
});
test("a unicode minus after a digit is also a range, not a sign", () => {
  const r = edit("from 5 to 3\n", "5\u22123\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test("a minus sign after a space or at the start still marks a negative number", () => {
  const r = edit("a drop of 4 points\n", "a change of -4 points\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ADDED -4/);
  assert.equal(edit("-5 and 5\n", "5 and -5\n").status, 0);
});
test("a number glued to letters is still a number (v2, x86)", () => {
  const r = edit("on v2\n", "on v2 and x86\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ADDED 86/);
});
test("a list is not merged: 1,000 is one number, 1, 000 is two", () => {
  const r = edit("1,000\n", "1, 000\n");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ADDED 1 000/);
});
test("a symbol unit must be attached (5% vs 5 %)", () => {
  const r = edit("5%\n", "5 %\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

// ---- the base ref is verified once, before any file ----------------------------------------------------------------

test("an option-shaped base ref is refused with exit 2", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  expectExit(run(dir, "-x", "doc.md"), 2, undefined, /bad base ref/);
});
test("a bad base ref exits 2 before an unreadable file is reported", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  expectExit(run(dir, "no-such-ref", "gone.md"), 2, undefined, /no-such-ref/);
});
test("several files are each compared against the base", () => {
  const dir = repo(
    { "a.md": "8s\n", "b.md": "9s\n" },
    { "a.md": "8s 64\n", "b.md": "9s\n" },
  );
  const r = run(dir, "HEAD", "a.md", "b.md");
  expectExit(r, 1, /a\.md: ADDED 64/);
  assert.match(r.stdout, /b\.md: unchanged numbers/);
});
test("a file in a directory absent from the base ref is new", () => {
  const dir = repo({ "doc.md": "8s\n" }, { "fresh/n.md": "5s\n" });
  expectExit(
    run(dir, "HEAD", "fresh/n.md"),
    1,
    /not in HEAD; every number is new/,
  );
});

// ---- the CLI through a symlink -------------------------------------------------------------------------------------

test("CLI runs through a symlink", () => {
  const dir = repo(
    { "doc.md": "took 8s\n" },
    { "doc.md": "took 8s on 64 cores\n" },
  );
  const r = viaLink(dir, "HEAD", "doc.md");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 64/);
});
test("CLI with too few arguments exits 2", () => {
  const r = run(tmp, "HEAD");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

// ---- leading-dot decimals -------------------------------------------------------------------------------------

test("DOT .5 ms -> 5 ms is an added number", () => {
  const r = edit("took .5 ms here\n", "took 5 ms here\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 5ms/);
});
test("DOT -.5 -> .5 is an added number (the sign is part of the token)", () => {
  const r = edit("delta -.5 here\n", "delta .5 here\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED \.5/);
});
test("DOT 0.5 and .5 are different tokens", () => {
  const r = edit("took 0.5 here\n", "took .5 here\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED \.5/);
});
test("DOT an unchanged .5 ms is unchanged", () => {
  const r = edit("took .5 ms here\n", "here took .5 ms\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test("DOT a version v1.2.3 does not yield a .3 token and is unchanged", () => {
  const same = edit("use v1.2.3 now\n", "now use v1.2.3\n");
  assert.equal(same.status, 0, same.stdout + same.stderr);
  const r = edit("use v1.2.3 now\n", "use v1.2.3 and v1.2.4 now\n");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /ADDED[^\n]*\.[34]\b(?!\.)/);
});

// ---- review: exponent signs and long-form unit words ------------------------------------------

for (const [a, b, added] of [
  ["1e-6", "1e+6", "1e\\+6"],
  ["1e+6", "1e6", "1e6"],
  ["1e6", "1e-6", "1e-6"],
  ["2.5E-3", "2.5E+3", "2\\.5E\\+3"],
]) {
  test(`EXP "${a}" -> "${b}" reads as a changed number`, () => {
    const r = edit(`a tolerance of ${a}.\n`, `a tolerance of ${b}.\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ADDED ${added}(\\s|$)`));
  });
}
test("EXP a letter e with no digits after it is still the number's unit", () => {
  assert.equal(
    edit("step 1e of the plan\n", "step 1e of the plan, reworded\n").status,
    0,
  );
  const r = edit("step 1e of the plan\n", "step 1f of the plan\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 1f/);
});
test("LONG a spaced unit word longer than 3 letters is kept: 10 milliseconds -> 10 microseconds", () => {
  const r = edit("it took 10 milliseconds\n", "it took 10 microseconds\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 10microseconds/);
});
test("LONG a reworded word after a number reads as a changed number (12 apps -> 12 applications)", () => {
  const r = edit("across 12 apps\n", "across 12 applications\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 12applications/);
});
test("LONG a function word after a number is still not a unit (3 of the apps)", () => {
  assert.equal(edit("3 of the apps\n", "3 of the apps, reworded\n").status, 0);
});

// ---- review: superscript and caret exponents belong to the unit -----------------------------

for (const [a, b, added] of [
  ["10 m²", "10 m³", "10m³"],
  ["5 s⁻¹", "5 s⁻²", "5s⁻²"],
  ["4 m/s²", "4 m/s³", "4m/s³"],
  ["10m²", "10m³", "10m³"],
  ["10 m^2", "10 m^3", "10m\\^3"],
  ["5 s^-1", "5 s^-2", "5s\\^-2"],
  ["10²", "10³", "10³"],
]) {
  test(`SUP "${a}" -> "${b}" is an added number`, () => {
    const r = edit(`an area of ${a} here\n`, `an area of ${b} here\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ADDED ${added}(\\s|$)`));
  });
}
test("SUP an unchanged 10 m² and 5 s⁻¹ are unchanged", () => {
  const r = edit("10 m² at 5 s⁻¹\n", "at 5 s⁻¹, 10 m²\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unchanged numbers/);
});
test("SUP an exponent is part of the unit: 10 m² -> 10 m is a change", () => {
  const r = edit("10 m² here\n", "10 m here\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 10m(\s|$)/);
});

// ---- review: Unicode vulgar fractions are numbers -------------------------------------------

const FRACTIONS = [..."½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒↉"];
for (const [a, b, added] of [
  ["½ ms", "¼ ms", "¼ms"],
  ["1½ ms", "1¼ ms", "1¼ms"],
  ["1½ ms", "1 ms", "1ms"],
  ["½ ms", "½ s", "½s"],
  ["⅔ of the runs", "⅓ of the runs", "⅓"],
  ["−½", "½", "½here"],
  ["1⁄2 ms", "1⁄4 ms", "1⁄4ms"],
  ["1⁄2 ms", "1 ms", "1ms"],
]) {
  test(`FRAC "${a}" -> "${b}" is an added number`, () => {
    const r = edit(`it took ${a} here\n`, `it took ${b} here\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ADDED (\\S+ )*${added}( |$)`, "m"));
  });
}
test("FRAC every vulgar fraction is a number", () => {
  for (const f of FRACTIONS) {
    const r = edit("took a while\n", `took ${f} h\n`);
    assert.equal(r.status, 1, `${f}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`ADDED ${f}h$`, "m"), f);
  }
});
test("FRAC an unchanged ½ ms, 1½ h and 1⁄2 ms are unchanged", () => {
  const r = edit("½ ms, 1½ h, 1⁄2 ms\n", "1⁄2 ms then 1½ h then ½ ms\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unchanged numbers/);
});

// ---- review: a hyphenated word after a number is its unit by the spaced rule ----------------------

for (const [a, b, added] of [
  ["a 10-ms delay", "a 10-s delay", "10s"],
  ["a 4-GHz part", "a 4-MHz part", "4MHz"],
  ["a 5-fold gain", "a 5-times gain", "5times"],
  ["a 2-way merge", "a 2-step merge", "2step"],
  ["a 64-bit build", "a 64-byte build", "64byte"],
]) {
  test(`HYPHEN "${a}" -> "${b}" is an added number`, () => {
    const r = edit(`${a} here\n`, `${b} here\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`ADDED .*${added}`));
  });
}
for (const [a, b] of [
  ["a 10-ms delay", "a 10 ms delay"],
  ["a 10-ms delay", "a 10ms delay"],
  ["a 5-fold gain", "a 5 fold gain"],
  ["a 64-bit build", "a 64 bit build"],
  ["a 64-core box", "64 cores"],
  ["a 5-minute wait", "5 minutes"],
  ["a 2-to-1 ratio", "a 2 to 1 ratio"],
  ["10-20 times", "10 and 20 times"],
]) {
  test(`HYPHEN "${a}" and "${b}" read as the same number`, () => {
    const r = edit(`${a} here\n`, `${b} here\n`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
