#!/usr/bin/env node
// Relative-link and #anchor checker for markdown, using GitHub's heading-slug rules
// (code kept as text, HTML tags such as <app> dropped, emphasis markers dropped,
// duplicate headings suffixed; ATX and setext headings, <a name>/id anchors).
//   node linkcheck.mjs <doc.md>...   (exit 1 on any broken link, 2 on a usage or read error)
//
// Link forms read: [t](dest), [t](dest "title"), [t](dest 'title'), [t](<dest with spaces>),
// ![alt](src), and `[ref]: dest` definitions. A destination starting with `/` is
// repository-root-relative: it resolves against the git top-level of the doc.
// `?query` is ignored and `#L10` / `#L10-L20` line anchors are accepted.
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/ /g, "-");

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeEntities = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, d, h, n) =>
    d
      ? String.fromCodePoint(+d)
      : h
        ? String.fromCodePoint(parseInt(h, 16))
        : (ENTITIES[n] ?? all),
  );

// A heading's text as GitHub renders it, before slugging: links → their text, code spans
// kept verbatim, HTML tags and emphasis markers dropped, backslash escapes resolved.
function headingText(raw) {
  const keep = [];
  const hold = (s) => `\u0000${keep.push(s) - 1}\u0000`;
  let t = raw
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(code.trim()))
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => hold(c))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  const word = "\\p{L}\\p{N}";
  const pairs = [
    [/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/gu, "$1"],
    [/\*\*(?=\S)([\s\S]*?\S)\*\*/gu, "$1"],
    [
      new RegExp(
        `(?<![${word}_])___(?=\\S)([\\s\\S]*?\\S)___(?![${word}_])`,
        "gu",
      ),
      "$1",
    ],
    [
      new RegExp(
        `(?<![${word}_])__(?=\\S)([\\s\\S]*?\\S)__(?![${word}_])`,
        "gu",
      ),
      "$1",
    ],
    [/\*(?=\S)([\s\S]*?\S)\*/gu, "$1"],
    [
      new RegExp(`(?<![${word}_])_(?=\\S)([\\s\\S]*?\\S)_(?![${word}_])`, "gu"),
      "$1",
    ],
    [/~~(?=\S)([\s\S]*?\S)~~/gu, "$1"],
  ];
  for (const [re, to] of pairs) t = t.replace(re, to);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

// fence open/close tracking: ``` or ~~~, closed by the same character, at least as long
const fenceOf = (line) => {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m ? { ch: m[1][0], n: m[1].length } : null;
};
function* outsideFences(lines) {
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const f = fenceOf(lines[i]);
    if (open) {
      if (
        f &&
        f.ch === open.ch &&
        f.n >= open.n &&
        /^ {0,3}[`~]+\s*$/.test(lines[i])
      )
        open = null;
      continue;
    }
    if (f) {
      open = f;
      continue;
    }
    yield [i, lines[i]];
  }
}

const anchorsCache = new Map();
function anchors(file) {
  if (anchorsCache.has(file)) return anchorsCache.get(file);
  const text = readFileSync(file, "utf8");
  const set = new Set();
  const seen = new Map();
  const add = (txt) => {
    const s = slug(headingText(txt));
    const n = seen.get(s) || 0;
    seen.set(s, n + 1);
    set.add(n ? `${s}-${n}` : s);
  };
  let para = []; // consecutive paragraph lines: a setext underline turns them into a heading
  let prev = -2;
  for (const [i, line] of outsideFences(text.split("\n"))) {
    if (i !== prev + 1) para = [];
    prev = i;
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (atx) {
      add((atx[1] ?? "").replace(/(?:^|[ \t]+)#+$/, ""));
      para = [];
      continue;
    }
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(line) && para.length) {
      add(para.join(" "));
      para = [];
      continue;
    }
    if (!line.trim()) para = [];
    else if (
      !/^ {0,3}([-*+]|\d+[.)])\s|^ {0,3}>|^\s*\||^ {0,3}(?:[-*_][ \t]*){3,}$/.test(
        line,
      )
    )
      para.push(line.trim());
    else para = [];
  }
  for (const m of text.matchAll(
    /<a\s[^>]*?\b(?:name|id)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
  ))
    set.add(m[1] ?? m[2]);
  for (const m of text.matchAll(
    /<(?!a\s)[a-z][a-z0-9]*\s[^>]*?\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi,
  ))
    set.add(m[1] ?? m[2]);
  anchorsCache.set(file, set);
  return set;
}

// destinations on one line (code spans removed), in order
function linkDests(line) {
  const text = line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
  const out = [];
  const def = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/.exec(text);
  if (def) out.push(def[1] ?? def[2]);
  for (const m of text.matchAll(/\]\(/g)) {
    let i = m.index + 2;
    while (/\s/.test(text[i] ?? "")) i++;
    let dest;
    if (text[i] === "<") {
      const end = text.indexOf(">", i);
      if (end < 0) continue;
      dest = text.slice(i + 1, end);
      i = end + 1;
    } else {
      let depth = 0;
      const from = i;
      for (; i < text.length; i++) {
        const c = text[i];
        if (/\s/.test(c)) break;
        if (c === "(") depth++;
        else if (c === ")" && depth-- === 0) break;
      }
      dest = text.slice(from, i);
      if (depth > 0) continue;
    }
    while (/\s/.test(text[i] ?? "")) i++;
    // optional title: "…", '…' or (…); the link must then close with `)`
    const q = text[i];
    if (q === '"' || q === "'" || q === "(") {
      const end = text.indexOf(q === "(" ? ")" : q, i + 1);
      if (end < 0) continue;
      i = end + 1;
      while (/\s/.test(text[i] ?? "")) i++;
    }
    if (text[i] !== ")") continue;
    out.push(dest);
  }
  return out;
}

const tops = new Map();
function gitTop(dir) {
  if (!tops.has(dir)) {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
    });
    tops.set(dir, r.status === 0 ? r.stdout.trim() : null);
  }
  return tops.get(dir);
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

// → null when the link is fine, else the reason
function check(file, href) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    return null;
  const hash = href.indexOf("#");
  const rawPath = (hash < 0 ? href : href.slice(0, hash)).replace(/\?.*$/, "");
  const rawFrag = hash < 0 ? undefined : href.slice(hash + 1);
  const p = rawPath ? decode(rawPath) : "";
  const frag = rawFrag === undefined ? undefined : decode(rawFrag);
  if (p === null || frag === null) return `malformed % escape in ${href}`;
  let target;
  if (!p) target = resolve(file);
  else if (p.startsWith("/")) {
    const top = gitTop(dirname(resolve(file)));
    if (!top)
      return `repository-root link ${href} but ${file} is not in a git repository`;
    target = join(top, p);
  } else target = resolve(dirname(file), p);
  if (!existsSync(target)) {
    // a literal "%20" in a file name
    const literal =
      rawPath && !rawPath.startsWith("/")
        ? resolve(dirname(file), rawPath)
        : null;
    if (!literal || !existsSync(literal)) return `missing file ${href}`;
    target = literal;
  }
  if (
    frag !== undefined &&
    frag !== "" &&
    statSync(target).isFile() &&
    target.endsWith(".md")
  ) {
    if (/^L\d+(-L\d+)?$/.test(frag)) return null;
    if (!anchors(target).has(frag)) return `missing anchor ${href}`;
  }
  return null;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node linkcheck.mjs <doc.md>...");
  process.exit(2);
}
let bad = 0;
let checked = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch (e) {
    console.error(`${f}: ${e.message}`);
    process.exit(2);
  }
  for (const [i, line] of outsideFences(text.split("\n"))) {
    for (const href of linkDests(line)) {
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
        continue;
      checked++;
      const why = check(f, href);
      if (why) {
        bad++;
        console.log(`${f}:${i + 1}: ${why}`);
      }
    }
  }
}
console.log(`checked ${checked} links, ${bad} broken`);
process.exit(bad ? 1 : 0);
