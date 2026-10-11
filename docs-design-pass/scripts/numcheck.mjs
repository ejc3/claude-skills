#!/usr/bin/env node
// Number-preservation check for an editorial pass on docs: compares the multiset of
// numbers in each doc against a base ref. An ADDED number fails (exit 1): an editor
// must not introduce data. A REMOVED number is listed for review: fine when the
// sentence was a repeat and the owning doc still states it.
//
//   node numcheck.mjs <base-ref> <doc.md>...
//
// Numbers keep their unit, attached ("8.3s") or after a space ("8.3 s"; the same
// number either way), so a unit change reads as a changed number. The units are
// WORD_UNITS and SYMBOL_UNITS below; a symbol unit must be attached. A unit only counts
// when no letter follows it ("3 sources" is the number 3). A minus sign counts only when
// no letter or digit precedes it ("10-20" is 10 and 20). Trailing punctuation is dropped,
// so moving a comma or a period does not read as a new number.
//
// Exit codes: 0 no added numbers, 1 added numbers, 2 the check could not run (bad ref,
// not a git repository, an unreadable file). A file that does not exist in the base ref
// is new: every number in it is new.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

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
  `(?<n>(?:(?<![\\p{L}\\p{N}])[−-])?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?)` +
    `(?:(?<u>${SPACE}*(?:${WORD_UNITS})|${SYMBOL_UNITS})(?![\\p{L}\\p{N}]))?`,
  "gu",
);
const SPACES = new RegExp(`${SPACE}+`, "gu");
const nums = (s) =>
  [...s.matchAll(NUMBER)].map(
    ({ groups: { n, u } }) => n + (u ?? "").replace(SPACES, ""),
  );

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

const dirOf = (f) => dirname(resolve(f));
// verified once, before any file is read (an option-shaped ref fails here too)
git(
  ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
  dirOf(files[0]),
  `bad base ref "${base}": `,
);

let bad = 0;
for (const f of files) {
  let current;
  try {
    current = readFileSync(f, "utf8");
  } catch (e) {
    die(`${f}: ${e.message}`);
  }
  // git runs in the file's directory; ./<name> is relative to it
  const cwd = dirOf(f);
  const path = `./${basename(f)}`;
  // ls-tree exits 0 with no output for a path the ref does not contain: that is a new file
  const entry = git(["ls-tree", base, "--", path], cwd).trim();
  let old = "";
  if (!entry) console.log(`${f}: not in ${base}; every number is new`);
  else if (!/^\d+ blob /.test(entry))
    die(`${f}: ${base}:${path} is not a regular file`);
  else old = git(["show", `${base}:${path}`], cwd);
  const delta = new Map();
  for (const n of nums(old)) delta.set(n, (delta.get(n) ?? 0) - 1);
  for (const n of nums(current)) delta.set(n, (delta.get(n) ?? 0) + 1);
  const added = [...delta].filter(([, d]) => d > 0).map(([n]) => n);
  const removed = [...delta].filter(([, d]) => d < 0).map(([n]) => n);
  if (added.length) {
    bad++;
    console.log(`${f}: ADDED ${added.join(" ")}`);
  }
  if (removed.length)
    console.log(`${f}: removed (check each was a repeat) ${removed.join(" ")}`);
  if (!added.length && !removed.length) console.log(`${f}: unchanged numbers`);
}
process.exit(bad ? 1 : 0);
