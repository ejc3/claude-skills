#!/usr/bin/env node
// Number-preservation check for an editorial pass on docs: compares the multiset of
// numbers in each doc against a base ref. An ADDED number fails (exit 1): an editor
// must not introduce data. A REMOVED number is listed for review: fine when the
// sentence was a repeat and the owning doc still states it.
//
//   node numcheck.mjs <base-ref> <doc.md>...
//
// Numbers keep their unit, attached ("8.3s") or after a space ("8.3 s"; the same
// number either way), so a unit change reads as a changed number. Units: % × x k M s ms
// µs min h KB MB GB TB KiB MiB GiB TiB Mbps Gbps. A unit only counts when no letter
// follows it ("3 sources" is the number 3). Trailing punctuation is dropped, so moving a
// comma or a period does not read as a new number.
//
// Exit codes: 0 no added numbers, 1 added numbers, 2 the check could not run (bad ref,
// not a git repository, an unreadable file). A file that does not exist in the base ref
// is new: every number in it is new.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

const [base, ...files] = process.argv.slice(2);
if (!base || !files.length)
  die("usage: node numcheck.mjs <base-ref> <doc.md>...");

const WORD_UNITS = "Gbps|Mbps|GiB|MiB|KiB|TiB|GB|MB|KB|TB|min|ms|µs|μs|s|h";
const SYMBOL_UNITS = "%|×|x|k|M";
const SPACE = "[ \\t\\u00a0\\u202f]";
const NUMBER = new RegExp(
  `[−-]?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?` +
    `(?:(?:${SPACE}*(?:${WORD_UNITS})|(?:${SYMBOL_UNITS}|${WORD_UNITS}))(?![\\p{L}\\p{N}]))?`,
  "gu",
);
const SPACES = new RegExp(`${SPACE}+`, "gu");
const nums = (s) =>
  (s.match(NUMBER) || [])
    .filter((n) => /\d/.test(n))
    .map((n) => n.replace(SPACES, ""));
const bag = (a) => a.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());

const git = (args, cwd, what = "") => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (r.error) die(`git: ${r.error.message}`);
  if (r.status !== 0)
    die(
      `${what}${(r.stderr || `git ${args.join(" ")} exited ${r.status}`).trim()}`,
    );
  return r.stdout;
};

let bad = 0;
for (const f of files) {
  let current;
  try {
    current = readFileSync(f, "utf8");
  } catch (e) {
    die(`${f}: ${e.message}`);
  }
  const dir = realpathSync(dirname(resolve(f)));
  const top = realpathSync(git(["rev-parse", "--show-toplevel"], dir).trim());
  const rel = relative(top, join(dir, basename(f)));
  const path = rel.split(sep).join("/");
  git(
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    top,
    `bad base ref "${base}": `,
  );
  // ls-tree exits 0 with no output for a path the ref does not contain: that is a new file
  const entry = git(["ls-tree", base, "--", path], top).trim();
  let old = "";
  if (!entry) console.log(`${f}: not in ${base}; every number is new`);
  else if (!/^\d+ blob /.test(entry))
    die(`${f}: ${base}:${path} is not a regular file`);
  else old = git(["show", `${base}:${path}`], top);
  const before = bag(nums(old));
  const after = bag(nums(current));
  const keys = new Set([...before.keys(), ...after.keys()]);
  const added = [...keys].filter(
    (k) => (after.get(k) || 0) > (before.get(k) || 0),
  );
  const removed = [...keys].filter(
    (k) => (after.get(k) || 0) < (before.get(k) || 0),
  );
  if (added.length) {
    bad++;
    console.log(`${f}: ADDED ${added.join(" ")}`);
  }
  if (removed.length)
    console.log(`${f}: removed (check each was a repeat) ${removed.join(" ")}`);
  if (!added.length && !removed.length) console.log(`${f}: unchanged numbers`);
}
process.exit(bad ? 1 : 0);
