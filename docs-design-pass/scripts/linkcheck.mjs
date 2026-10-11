#!/usr/bin/env node
// Relative-link and #anchor checker for markdown, using GitHub's heading-slug rules
// (code kept as text, HTML tags such as <app> dropped, emphasis markers dropped,
// duplicate headings suffixed; ATX and setext headings, <a name>/id anchors).
//   node linkcheck.mjs <doc.md>...   (exit 1 on any broken link, 2 on a usage or read error)
//
// Link forms read: [t](dest), [t](dest "title"), [t](dest 'title'), [t](<dest with spaces>),
// ![alt](src), and `[ref]: dest` definitions. Full [t][label] and collapsed [label][]
// reference usages must name a definition (labels match case-insensitively, whitespace
// collapsed); a shortcut [label] is ordinary text unless a definition exists, and then the
// definition's destination is what gets checked. A destination starting with `/` is
// repository-root-relative: it resolves against the git top-level of the doc.
// `?query` is ignored and `#L10` / `#L10-L20` line anchors are accepted.
import { readFileSync, statSync } from "node:fs";
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
  // * and ~ never reach the slug; only underscore emphasis (a pair not touching a word
  // character) must be removed, so snake_case_names keep theirs
  t = t.replace(
    /(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu,
    "$2",
  );
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

// Every line as [index, text], with a fenced block (``` or ~~~, closed by the same
// character at least as long) and its delimiter lines blank, so line numbers survive.
function* outsideFences(lines) {
  let close = null;
  for (const [i, line] of lines.entries()) {
    if (close) {
      if (close.test(line)) close = null;
      yield [i, ""];
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open)
      close = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}\\s*$`);
    yield [i, open ? "" : line];
  }
}

const ANCHOR_ATTR =
  /<(?:a\b[^>]*?\s(?:id|name)|[a-z][a-z0-9]*\b[^>]*?\sid)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
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
  const kept = [];
  let para = []; // consecutive paragraph lines: a setext underline turns them into a heading
  for (const [, line] of outsideFences(text.split("\n"))) {
    kept.push(line);
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
  // id on any tag, name on <a>, outside code blocks
  for (const m of kept.join("\n").matchAll(ANCHOR_ATTR)) set.add(m[1] ?? m[2]);
  anchorsCache.set(file, set);
  return set;
}

// [text](dest "title"): dest is <angle> or bare with one level of balanced parentheses;
// the title is "…", '…' or (…); the link must close with `)`
const LINK =
  /\]\(\s*(?:<([^>]*)>|((?:[^\s()]|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

// destinations on one line (code spans removed), in order
function linkDests(line) {
  const text = line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
  const out = [];
  const def =
    /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/.exec(
      text,
    );
  if (def) out.push(def[1] ?? def[2]);
  for (const m of text.matchAll(LINK)) out.push(m[1] ?? m[2]);
  return out;
}

// reference labels compare case-insensitively with internal whitespace collapsed
const normLabel = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();

// the labels of the `[label]: dest` definitions in a document's lines (fences already blank)
function definedLabels(lines) {
  const set = new Set();
  for (const [, line] of lines) {
    const m =
      /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[((?:\\.|[^\]\\])+)\]:/.exec(
        line,
      );
    if (m && m[1].trim() && !m[1].startsWith("^")) set.add(normLabel(m[1]));
  }
  return set;
}

// full [text][label] and collapsed [label][] usages on one line (code spans removed):
// [{ label, shown }]
function refUsages(line) {
  const text = line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
  const out = [];
  for (const m of text.matchAll(
    /(?<!\\)\[((?:\\.|[^\[\]\\])*\S(?:\\.|[^\[\]\\])*)\]\[([^\[\]]*)\]/g,
  )) {
    const label = m[2].trim() ? m[2] : m[1];
    if (label.startsWith("^")) continue;
    out.push({
      label,
      shown: m[2].trim() ? `[${m[1]}][${m[2]}]` : `[${m[1]}][]`,
    });
  }
  return out;
}

const isExternal = (href) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href);

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
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st) return `missing file ${href}`;
  if (frag && st.isFile() && target.endsWith(".md")) {
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
  const lines = [...outsideFences(text.split("\n"))];
  const defined = definedLabels(lines);
  for (const [i, line] of lines) {
    for (const u of refUsages(line)) {
      checked++;
      if (!defined.has(normLabel(u.label))) {
        bad++;
        console.log(`${f}:${i + 1}: undefined reference ${u.shown}`);
      }
    }
    for (const href of linkDests(line)) {
      if (!href || isExternal(href)) continue;
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
