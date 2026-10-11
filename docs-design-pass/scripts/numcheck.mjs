#!/usr/bin/env node
// Number-preservation check for an editorial pass on docs: compares the multiset of
// numbers in each doc against a base ref. An ADDED number fails (exit 1): an editor
// must not introduce data. A REMOVED number is listed for review: fine when the
// sentence was a repeat and the owning doc still states it.
//
//   node numcheck.mjs <base-ref> <doc.md>...
//
// A number keeps the unit that follows it, so a unit change reads as a changed number
// (4 GHz -> 4 MHz, 20 °C -> 20 °F, 247 MB -> 247 GB). The unit is the run of letters,
// `°`, `%`, `×` and a `/` between letters right after the number, with at most one space between them:
//   - attached ("8.3s", "12x", "5%", "3×", "20°"): always a unit.
//   - after a space: a unit only if it cannot be an ordinary word: a known unit (KNOWN
//     below), a token containing `°` or `/` with a letter ("°C", "req/s", "MB/s"), or an
//     acronym-shaped token (an upper-case letter after the first: "GHz", "kHz", "MiB",
//     "GB", "CPUs"). Any other word is not a unit ("3 sources", "10 to 20", "5 or 6").
//     `%` and `×` need no space, so "5 %" is not "5%".
//   - count nouns ("files", "lines", "tasks", "apps", "cores", "days", ...) are known
//     units, because a changed count noun is a change ("5 files" -> "5 lines"). They match
//     singular or plural and with a hyphen ("64 cores" = "64-core"); an unlisted plural
//     noun ("3 sources") stays a word.
// "3x4" and "5/10" are numbers without units. A minus sign counts only when no letter or
// digit precedes it ("10-20" is 10 and 20). Trailing punctuation is dropped, so moving a
// comma or a period does not read as a new number.
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

// lower-case words that count as units after a space; the nouns also match their plural
const WORD_UNITS = [
  ...[
    "ms",
    "µs",
    "μs",
    "ns",
    "s",
    "h",
    "sec",
    "secs",
    "min",
    "mins",
    "hr",
    "hrs",
  ],
  ...[
    "Hz",
    "Kb",
    "Mb",
    "Gb",
    "Tb",
    "kb",
    "Kbps",
    "kbps",
    "Mbps",
    "mbps",
    "Gbps",
    "gbps",
  ],
];
const COUNT_NOUNS = [
  ...["second", "minute", "hour", "day", "week", "month", "year", "byte"],
  ...["file", "line", "task", "app", "package", "core", "module", "lib", "run"],
  ...[
    "sample",
    "test",
    "thread",
    "worker",
    "page",
    "component",
    "request",
    "runner",
  ],
  ...["job", "step", "commit", "error", "point"],
];
const NOUN_FORM = new Map(
  COUNT_NOUNS.flatMap((w) => [
    [w, w],
    [`${w}s`, w],
  ]),
);
const SPACE = "[ \\t\\u00a0\\u202f]";
const NUMBER = /(?<n>(?:(?<![\p{L}\p{N}])[−-])?\d(?:[\d,]*\d)?(?:\.\d+)?)/gu;
const TAIL = new RegExp(
  `^(?<sp>${SPACE}?)(?<hy>-?)(?<tok>[\\p{L}°%×]+(?:/\\p{L}+)*)(?![\\p{L}\\p{N}°%×])`,
  "u",
);
const hasLetter = /\p{L}/u;
const acronym = /^(?:\p{Lu}{2,}\p{L}*|\p{L}\p{Ll}*\p{Lu}\p{L}*)$/u;

// the unit at the start of `rest` ("" for none), in a form that ignores spacing
const unitAt = (rest) => {
  const m = TAIL.exec(rest);
  if (!m) return "";
  const { sp, hy, tok } = m.groups;
  const noun = NOUN_FORM.get(tok);
  if (hy) return !sp && noun ? noun : ""; // "64-core": only a count noun takes a hyphen
  if (noun) return noun;
  if (!sp) return tok;
  if (WORD_UNITS.includes(tok)) return tok;
  if (!hasLetter.test(tok)) return "";
  if (/[°/]/.test(tok) || acronym.test(tok)) return tok;
  return "";
};
const nums = (s) =>
  [...s.matchAll(NUMBER)].map(
    (m) => m.groups.n + unitAt(s.slice(m.index + m[0].length)),
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
