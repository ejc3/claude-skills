#!/usr/bin/env node
// Relative-link and #anchor checker for markdown, using GitHub's heading-slug rules
// (backticks kept as text, HTML tags such as <app> dropped, duplicate headings suffixed).
//   node linkcheck.mjs <doc.md>...   (exit 1 on any broken link)
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
const slug = (h) => h.trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
  .replace(/ /g, "-");
const anchorsCache = new Map();
function anchors(file) {
  if (anchorsCache.has(file)) return anchorsCache.get(file);
  const text = readFileSync(file, "utf8");
  const set = new Set(); const seen = new Map();
  let inCode = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    // strip markdown link/code syntax from heading text
    const txt = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").split("`").map((seg, i) => (i % 2 ? seg : seg.replace(/<[^>]+>/g, ""))).join("");
    let s = slug(txt);
    const n = seen.get(s) || 0; seen.set(s, n + 1);
    set.add(n ? `${s}-${n}` : s);
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
  anchorsCache.set(file, set);
  return set;
}
let bad = 0, checked = 0;
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, "utf8");
  let inCode = false; let ln = 0;
  for (const line of text.split("\n")) {
    ln++;
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^[a-z]+:/i.test(href)) continue;
      checked++;
      const [p, a] = href.split("#");
      const target = p ? resolve(dirname(f), p) : resolve(f);
      if (!existsSync(target)) { bad++; console.log(`${f}:${ln}: missing file ${href}`); continue; }
      if (a !== undefined && statSync(target).isFile() && target.endsWith(".md")) {
        if (!anchors(target).has(decodeURIComponent(a))) { bad++; console.log(`${f}:${ln}: missing anchor ${href}`); }
      }
    }
  }
}
console.log(`checked ${checked} links, ${bad} broken`);
process.exit(bad ? 1 : 0);
