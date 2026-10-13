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
// `°`, `%` and `×` right after the number, with at most one space between them, then any
// further factors joined to it by `·`, `×`, `*` or `/` (each a run of letters), each run of
// letters keeping its exponent (10 m² -> 10 m³, 5 s⁻¹, 10 m^2, 10 m·s⁻¹ -> 10 m·s⁻²,
// kg·m/s²), so a compound unit is compared whole; a superscript attached to the number is
// its unit too (10² -> 10³):
//   - attached ("8.3s", "12x", "5%", "3×", "20°"): always a unit.
//   - after a space: any word is the unit ("12 V", "247 GB", "10 milliseconds",
//     "3 sources"), except a function word ("10 to 20", "5 or 6", "3 of the apps"; a lone
//     capital letter is never one: "12 A" is amperes). The tool cannot tell a unit it does
//     not list from an ordinary word, and a changed unit must not pass, so rewording the
//     word after a number reads as a changed number: the editor justifies it.
//     `%` and `×` need no space, so "5 %" is not "5%".
//   - after a hyphen: the same rule as after a space ("a 10-ms delay" = "a 10 ms delay",
//     "5-fold" = "5 fold", "a 2-to-1 ratio" keeps 2 bare). A hyphen before digits is a
//     range ("10-20").
//   - count nouns (COUNT_NOUNS below: "files", "tasks", "apps", "cores", "days", ...)
//     match singular or plural ("64 cores" = "64-core").
// A number may carry an exponent with its sign: 1e-6, 1e+6 and 1e6 are three numbers.
// A vulgar fraction is a number, alone or after digits (½, 1½), as is 1⁄2 (fraction slash).
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
// short English words that follow a number without being its unit ("3 of the apps", "5 x 3")
const FUNCTION_WORDS = new Set([
  ..."a an and are as at be by for if in is it of on or so the to was we x".split(
    " ",
  ),
  ..."vs but not can has had did how may now new old all any out off up per via one two our you its".split(
    " ",
  ),
]);
const SPACE = "[ \\t\\u00a0\\u202f]";
// an optional sign, then digits with an optional fraction, or a leading-dot decimal (.5),
// then an optional exponent with its sign (1e-6, 1e+6 and 1e6 are three numbers; an "e"
// with no digits after it is left to the unit, "1e"). The sign and a bare leading dot
// both need a non-alphanumeric left neighbour, so the ".3" of "v1.2.3" and the "-" of
// "x-5" are not tokens of their own. A vulgar fraction (½, ⅔, ↉, ...) is a number alone or
// after digits ("1½"), and so is a fraction-slash form ("1⁄2").
const FRACTION = "[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒↉]";
const NUMBER = new RegExp(
  `(?<n>(?:(?<![\\p{L}\\p{N}])[−-])?(?:\\d(?:[\\d,]*\\d)?(?:${FRACTION}|⁄\\d+|(?:\\.\\d+)?(?:[eE][+−-]?\\d+)?)|(?<![\\p{L}\\p{N}.])\\.\\d+(?:[eE][+−-]?\\d+)?|${FRACTION}))`,
  "gu",
);
// an exponent on a unit: superscript (m², s⁻¹) or caret (m^2, s^-1)
const SUPERSCRIPT = "[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+";
const EXPONENT = `(?:${SUPERSCRIPT}|\\^[+−-]?\\d+)`;
const TAIL = new RegExp(
  `^(?<sp>${SPACE}?)(?<hy>-?)(?<tok>[\\p{L}°%×]+${EXPONENT}?(?:[·×*/]\\p{L}+${EXPONENT}?)*|${SUPERSCRIPT})(?![\\p{L}\\p{N}°%×])`,
  "u",
);
const hasLetter = /\p{L}/u;
const acronym = /^(?:\p{Lu}{2,}\p{L}*|\p{L}\p{Ll}*\p{Lu}\p{L}*)$/u;

// the unit at the start of `rest` ("" for none), in a form that ignores spacing
const unitAt = (rest) => {
  const m = TAIL.exec(rest);
  if (!m) return "";
  const { sp, hy, tok } = m.groups;
  // a hyphen after a space is a dash, not a joiner ("5 -fold")
  if (hy && sp) return "";
  const noun = NOUN_FORM.get(tok);
  if (noun) return noun;
  // attached: always the unit. A hyphenated word ("10-ms", "5-fold") is read as a spaced
  // one, so "a 10-ms delay" = "a 10 ms delay" and "a 2-to-1 ratio" keeps 2 bare
  if (!sp && !hy) return tok;
  if (WORD_UNITS.includes(tok)) return tok;
  if (!hasLetter.test(tok)) return "";
  if (/[°/·×*]/.test(tok) || acronym.test(tok)) return tok;
  // any other word is kept as the unit ("12 V", "10 milliseconds"), unless it is a
  // function word ("3 of the apps"): the tool cannot tell an unlisted unit from a word, and
  // a changed unit must not pass, so a reworded word after a number reads as a changed
  // number. A lone capital letter is never a function word ("12 A" is amperes).
  if (FUNCTION_WORDS.has([...tok].length > 1 ? tok.toLowerCase() : tok))
    return "";
  return tok;
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
