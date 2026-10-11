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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./numcheck.mjs", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "numcheck-test-"));

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
// a repository whose HEAD holds `files`; returns its directory
const repo = (files) => {
  const dir = join(tmp, `repo${n++}`);
  mkdirSync(dir);
  git(dir, "init", "-q");
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
};
const run = (cwd, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
// numcheck HEAD doc.md after rewriting doc.md to `after`
const edit = (before, after) => {
  const dir = repo({ "doc.md": before });
  writeFileSync(join(dir, "doc.md"), after);
  return run(dir, "HEAD", "doc.md");
};

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
test("F7 a following word is not a unit (3 sources / 3 services)", () => {
  const r = edit("3 sources and 5 hours\n", "3 services and 5 hours\n");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test("F7 a space-separated unit change is listed as removed and added", () => {
  const r = edit("took 247 MB\n", "took 247 GB\n");
  assert.match(r.stdout, /ADDED 247GB/);
  assert.match(r.stdout, /removed .*247MB/);
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
  const dir = join(tmp, "plain");
  mkdirSync(dir);
  writeFileSync(join(dir, "doc.md"), "took 8s\n");
  const r = run(dir, "HEAD", "doc.md");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /every number is new/);
  assert.match(r.stderr, /not a git repository/);
});
test("F8 a file in another directory that is not in a repository exits 2", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  const other = join(tmp, "elsewhere");
  mkdirSync(other);
  writeFileSync(join(other, "x.md"), "8s\n");
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
  const dir = repo({ "doc.md": "took 8s\n" });
  writeFileSync(join(dir, "new.md"), "took 9s\n");
  const r = run(dir, "HEAD", "new.md");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /not in HEAD; every number is new/);
  assert.match(r.stdout, /ADDED 9s/);
});
test("F8 a new file without numbers exits 0", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  writeFileSync(join(dir, "new.md"), "no figures here\n");
  const r = run(dir, "HEAD", "new.md");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test("F8 a relative path from a subdirectory resolves against the repository", () => {
  const dir = repo({ "docs/a.md": "took 8s on 64 cores\n" });
  writeFileSync(join(dir, "docs/a.md"), "took 8s on 64 cores, reworded\n");
  const r = run(join(dir, "docs"), "HEAD", "a.md");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /unchanged numbers/);
});
test("F8 an absolute path works from any directory", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  const r = run(tmp, "HEAD", join(dir, "doc.md"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---- the CLI through a symlink -------------------------------------------------------------------------------------

test("CLI runs through a symlink", () => {
  const dir = repo({ "doc.md": "took 8s\n" });
  writeFileSync(join(dir, "doc.md"), "took 8s on 64 cores\n");
  const link = join(tmp, "numcheck-link.mjs");
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, [link, "HEAD", "doc.md"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ADDED 64/);
});
test("CLI with too few arguments exits 2", () => {
  const r = run(tmp, "HEAD");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
