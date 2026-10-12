#!/usr/bin/env node
// Relative-link and #anchor checker for markdown, using GitHub's heading-slug rules
// (code kept as text, HTML tags such as <app> dropped, emphasis markers dropped,
// duplicate headings suffixed -1, -2, ... skipping any slug already taken, so foo, foo,
// foo-1 are foo, foo-1, foo-1-1; ATX and setext headings, <a name>/id anchors).
//   node linkcheck.mjs <doc.md>...   (exit 1 on any broken link, 2 on a usage or read error)
//
// Link forms read: [t](dest), [t](dest "title"), [t](dest 'title'), [t](<dest with spaces>),
// ![alt](src) (a bare dest may nest balanced parentheses to any depth or escape them with
// `\`; an unbalanced one is not a link), and `[ref]: dest` definitions (the dest may
// start the next line; a definition with no destination defines nothing). Full
// [t][label] and collapsed [label][] reference usages must name a definition (labels
// match case-insensitively, whitespace collapsed); a shortcut [label] is ordinary text
// unless a definition exists, and then the definition's destination is what gets
// checked. A destination starting with `/` is repository-root-relative: it resolves
// against the git top-level of the doc.
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
  // a placeholder of private-use characters, which a link destination may contain
  const hold = (s) => `\ue000${keep.push(s) - 1}\ue001`;
  let t = raw
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(code.trim()))
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => hold(c));
  t = inlineLinks(t)
    .reduceRight(
      (acc, { start, end, text }) =>
        acc.slice(0, start) + text + acc.slice(end),
      t,
    )
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  // * and ~ never reach the slug; only underscore emphasis (a pair not touching a word
  // character) must be removed, so snake_case_names keep theirs
  t = t.replace(
    /(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu,
    "$2",
  );
  return t.replace(/\ue000(\d+)\ue001/g, (_, i) => keep[+i]);
}

// Every line as [index, text], with a fenced block (``` or ~~~, closed by the same
// character at least as long) and its delimiter lines blank, so line numbers survive; an
// indented code block (lines indented 4 spaces or a tab, starting at the top of the file
// or after a blank line) is blanked too. Lists are not tracked: a list item's indented
// continuation after a blank line reads as code, so a definition there does not count
// and a link there is not checked.
function* outsideFences(lines) {
  let close = null;
  let code = false;
  let afterBlank = true;
  for (const [i, line] of lines.entries()) {
    if (close) {
      if (close.test(line)) close = null;
      yield [i, ""];
      afterBlank = false;
      continue;
    }
    if (!line.trim()) {
      afterBlank = true;
      yield [i, line];
      continue;
    }
    code = /^(?: {4}|\t| {1,3}\t)/.test(line) && (code || afterBlank);
    afterBlank = false;
    if (code) {
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
  // a duplicate gets the first free `-n` suffix after the last one its base used, probed
  // against every slug assigned so far: foo, foo, foo-1 → foo, foo-1, foo-1-1
  const seen = new Map();
  const add = (txt) => {
    const base = slug(headingText(txt));
    let s = base;
    while (set.has(s)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      s = `${base}-${n}`;
    }
    set.add(s);
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

// backslash escapes of ASCII punctuation, resolved
const unescape = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
// the inline link whose `](` is at s[i] (CommonMark 0.31.2 §6.3): its destination, in
// <...> (no unescaped < or >) or bare (no space or control character; parentheses
// balanced at any depth or backslash-escaped), then an optional title "…", '…' or (…)
// after whitespace, then `)`. → { dest, end } with end just past the `)`, else null
// (an unbalanced or unclosed destination is not a link)
function linkTail(s, i) {
  const SPACE = /[ \t]/;
  let j = i + 2;
  while (SPACE.test(s[j] ?? "")) j++;
  let dest;
  if (s[j] === "<") {
    const from = ++j;
    for (; j < s.length && s[j] !== ">"; j++) {
      if (s[j] === "<") return null;
      if (s[j] === "\\" && j + 1 < s.length) j++;
    }
    if (j >= s.length) return null;
    dest = s.slice(from, j++);
  } else {
    const from = j;
    let depth = 0;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === "\\" && /[!-/:-@[-`{-~]/.test(s[j + 1] ?? "")) j++;
      else if (c === "(") depth++;
      else if (c === ")") {
        if (!depth) break;
        depth--;
      } else if (/[\x00-\x20\x7f]/.test(c)) break;
    }
    if (depth) return null;
    dest = s.slice(from, j);
  }
  const title =
    /^(?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?[ \t]*\)/.exec(
      s.slice(j),
    );
  if (!title) return null;
  return { dest: unescape(dest), end: j + title[0].length };
}
// the inline links and images on one line: [{ start, end, text, dest }], start at the
// opening `[` (or `!`), text the bracketed text. Link text holds no brackets here
function inlineLinks(s) {
  const out = [];
  for (const m of s.matchAll(/!?\[([^\]]*)\]\(/g)) {
    if (out.length && m.index < out.at(-1).end) continue;
    const tail = linkTail(s, m.index + m[0].length - 2);
    if (tail) out.push({ start: m.index, end: tail.end, text: m[1], ...tail });
  }
  return out;
}

const noCode = (line) =>
  line.replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));

// a `[label]: dest` definition on one line (code spans removed) → { label, dest }, else
// null. A footnote (`[^n]:`) is not a link definition. A definition with nothing after the
// colon takes its destination from `next`, the following line (CommonMark allows one line
// ending before the destination): inside the same blockquote, holding only the destination
// and an optional title. With no destination there is no definition: `dest` is undefined
// and the label stays undefined.
function definition(line, next = "") {
  const def =
    /^((?:[ \t]*>)*)[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[((?:\\.|[^\]\\])+)\]:[ \t]*(?:<([^>]*)>|(\S+))?/.exec(
      noCode(line),
    );
  if (!def || !def[2].trim() || def[2].startsWith("^")) return null;
  const label = def[2];
  if ((def[3] ?? def[4]) !== undefined)
    return { label, dest: def[3] ?? def[4] };
  const quotes = def[1].split(">").length - 1;
  const rest = noCode(next).replace(
    new RegExp(`^(?:[ \\t]*>){0,${quotes}}`),
    "",
  );
  const dest =
    /^[ \t]*(?:<([^>]*)>|([^\s>]\S*))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/.exec(
      rest,
    );
  return { label, dest: dest ? (dest[1] ?? dest[2]) : undefined };
}

// destinations on one line (code spans removed), in order: a definition's, then each link's
function linkDests(line, next = "") {
  const out = [];
  const dest = definition(line, next)?.dest;
  if (dest !== undefined) out.push(dest);
  const text = noCode(line);
  let end = 0;
  for (const m of text.matchAll(/\]\(/g)) {
    if (m.index < end) continue; // inside the link before it
    const tail = linkTail(text, m.index);
    if (!tail) continue;
    end = tail.end;
    out.push(tail.dest);
  }
  return out;
}

// reference labels compare case-insensitively with internal whitespace collapsed
const normLabel = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();

// the labels of the `[label]: dest` definitions that have a destination, in a document's
// lines (fences already blank)
function definedLabels(lines) {
  const set = new Set();
  for (const [k, [, line]] of lines.entries()) {
    const def = definition(line, lines[k + 1]?.[1]);
    if (def?.dest !== undefined) set.add(normLabel(def.label));
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
  for (const [k, [i, line]] of lines.entries()) {
    for (const u of refUsages(line)) {
      checked++;
      if (!defined.has(normLabel(u.label))) {
        bad++;
        console.log(`${f}:${i + 1}: undefined reference ${u.shown}`);
      }
    }
    for (const href of linkDests(line, lines[k + 1]?.[1])) {
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
