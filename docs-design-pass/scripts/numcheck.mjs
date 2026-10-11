#!/usr/bin/env node
// Number-preservation check for an editorial pass on docs: compares the multiset of
// numbers in each doc against a base ref. An ADDED number fails (exit 1): an editor
// must not introduce data. A REMOVED number is listed for review: fine when the
// sentence was a repeat and the owning doc still states it.
//
//   node numcheck.mjs <base-ref> <doc.md>...
//
// Numbers keep their unit suffix (s, ms, %, ×, GB, MB, k, M) and drop trailing
// punctuation, so moving a comma or a period does not read as a new number.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [base, ...files] = process.argv.slice(2);
if (!base || !files.length) {
  console.error("usage: node numcheck.mjs <base-ref> <doc.md>...");
  process.exit(2);
}
const nums = (s) =>
  (s.match(/[−-]?\d(?:[\d,]*\d)?(?:\.\d+)?(?:[%×x]|GB|MB|KB|ms|s|k|M)?/g) || []).filter((n) =>
    /\d/.test(n),
  );
const bag = (a) => a.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
let bad = 0;
for (const f of files) {
  let old = "";
  try {
    old = execFileSync("git", ["show", `${base}:${f}`], { encoding: "utf8" });
  } catch {
    console.log(`${f}: not in ${base}; every number is new`);
  }
  const before = bag(nums(old));
  const after = bag(nums(readFileSync(f, "utf8")));
  const keys = new Set([...before.keys(), ...after.keys()]);
  const added = [...keys].filter((k) => (after.get(k) || 0) > (before.get(k) || 0));
  const removed = [...keys].filter((k) => (after.get(k) || 0) < (before.get(k) || 0));
  if (added.length) {
    bad++;
    console.log(`${f}: ADDED ${added.join(" ")}`);
  }
  if (removed.length) console.log(`${f}: removed (check each was a repeat) ${removed.join(" ")}`);
  if (!added.length && !removed.length) console.log(`${f}: unchanged numbers`);
}
process.exit(bad ? 1 : 0);
