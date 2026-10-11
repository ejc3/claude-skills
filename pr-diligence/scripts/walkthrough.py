#!/usr/bin/env python3
"""Build a pull request walkthrough page from git, so every line of code on it
is exactly what the branch contains.

Use as a library from a small per-PR generator:

    import sys; sys.path.insert(0, "<skill dir>/scripts")
    from walkthrough import *

    repo = Repo("~/src/project")
    page = {
        "HEAD": repo.short("fix-branch"),
        "BASE": repo.short("upstream/master"),
        "CHANGE": repo.diff("upstream/master", "fix-branch", "menu.c",
                            marks={201: 1, 205: 2}, src="menu.c, the change"),
        "OLD": repo.excerpt("upstream/master", "menu.c", 194, 202,
                            hot=[200], src="menu.c on master"),
        "PRBODY": markdown(pr_body), ...
    }
    build("body.html", "out.html", page, title="Short page name")

Line numbers passed to excerpt(), diff() and their hot/marks arguments are
always the file's own line numbers, never offsets into the excerpt.

Run as a script to check a built page:

    walkthrough.py check out.html [--private REGEX]

which prints every highlighted and added line per code block (check each one
lands where the prose says) and any private-pattern hits.
"""

import html
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES = os.path.join(HERE, "..", "templates")

__all__ = ["Repo", "esc", "code_block", "text_block", "markdown", "build",
           "check"]


def esc(s):
    return html.escape(s, quote=False)


class Repo:
    def __init__(self, path):
        self.path = os.path.expanduser(path)

    def git(self, *args):
        return subprocess.run(["git", "-C", self.path] + list(args),
                              capture_output=True, text=True,
                              check=True).stdout

    def short(self, rev):
        return self.git("rev-parse", "--short", rev).strip()

    def show(self, rev, path):
        return self.git("show", "%s:%s" % (rev, path))

    def lines(self, rev, path):
        return self.show(rev, path).split("\n")

    def commits(self, base, head):
        out = self.git("log", "--reverse", "--format=%s%n%n%b%x00",
                       "%s..%s" % (base, head))
        return [c.strip("\n") for c in out.split("\x00") if c.strip()]

    def excerpt(self, rev, path, first, last, hot=(), marks=None, src=None,
                label=None):
        """Lines first..last (1-based, inclusive) of path at rev."""
        ls = self.lines(rev, path)[first - 1:last]
        rows = [("!" if first + i in hot else " ", l) for i, l in enumerate(ls)]
        m = {i: v for i, v in ((n - first, v)
                               for n, v in (marks or {}).items())}
        return code_block(rows, start=first, marks=m,
                          src=src or "%s:%d-%d" % (path, first, last),
                          label=label)

    def diff(self, base, head, path, context=3, marks=None, src=None,
             label=None):
        """The real unified diff of path, rendered with the new file's line
        numbers. marks are keyed by new-file line number."""
        out = self.git("diff", "-U%d" % context, base, head, "--", path)
        rows, starts = [], []
        new_no = None
        numbered = []
        for line in out.split("\n"):
            h = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", line)
            if h:
                if rows:
                    rows.append((" ", "\t..."))
                    numbered.append(None)
                new_no = int(h.group(1))
                continue
            if new_no is None or line.startswith("\\"):
                continue
            if line.startswith("+"):
                rows.append(("+", line[1:]))
                numbered.append(new_no)
                new_no += 1
            elif line.startswith("-"):
                rows.append(("-", line[1:]))
                numbered.append(None)
            elif line.startswith(" ") or line == "":
                if line == "" and not rows:
                    continue
                rows.append((" ", line[1:]))
                numbered.append(new_no)
                new_no += 1
        while rows and rows[-1] == (" ", ""):
            rows.pop()
            numbered.pop()
        m = {}
        for i, n in enumerate(numbered):
            if n is not None and marks and n in marks:
                m[i] = marks[n]
        adds = sum(1 for k, _ in rows if k == "+")
        dels = sum(1 for k, _ in rows if k == "-")
        return code_block(rows, numbers=numbered, marks=m,
                          src=src or path,
                          label=label or ("+%d" % adds +
                                          (" −%d" % dels if dels else "")))


def code_block(rows, start=None, numbers=None, marks=None, src=None,
               label=None):
    """rows: [(kind, text)], kind ' ' plain, '!' highlighted, '+' added,
    '-' removed. numbers: an explicit line number per row (None for none),
    or start: the first line's number."""
    marks = marks or {}
    out = []
    n = start
    for i, (k, t) in enumerate(rows):
        cls = {"+": "add", "-": "del", "!": "hot", " ": ""}[k]
        if numbers is not None:
            no = "" if numbers[i] is None else str(numbers[i])
        elif n is not None:
            no = "" if k == "-" else str(n)
            if k != "-":
                n += 1
        else:
            no = ""
        callout = ('<span class="callout">%s</span>' % marks[i]
                   if i in marks else "")
        sign = k if k in "+-" else " "
        out.append('<span class="ln %s"><span class="no">%s</span>'
                   '<span class="sg">%s</span><span class="tx">%s</span>%s'
                   '</span>' % (cls, no, sign, esc(t.expandtabs(8)) or " ",
                                callout))
    head = ""
    if src:
        head = '<div class="codehead"><span>%s</span>%s</div>' % (
            esc(src), "<span>%s</span>" % esc(label) if label else "")
    return ('<figure class="code">%s<pre><code>%s</code></pre></figure>'
            % (head, "".join(out)))


def text_block(text, hot_rows=(), src=None):
    """A block of non-file text (a sanitizer report, a log). hot_rows are
    0-based row indexes."""
    rows = [("!" if i in hot_rows else " ", l)
            for i, l in enumerate(text.rstrip("\n").split("\n"))]
    return code_block(rows, src=src)


def _inline(s):
    s = esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(https://[^\s<)]+)", r'<a href="\1">\1</a>', s)
    return s


def markdown(text):
    """Enough Markdown for a pull request body: paragraphs, - lists, fenced
    code, | tables, inline code, bold and bare https links."""
    out, para, code, table = [], [], None, []
    in_list = False

    def flush():
        nonlocal para, table, in_list
        if para:
            out.append("<p>%s</p>" % _inline(" ".join(para)))
            para = []
        if table:
            rows = [r for r in table if not re.match(r"^\|[\s|:-]+\|$", r)]
            cells = [[c.strip().replace("\\|", "|")
                      for c in re.split(r"(?<!\\)\|", r.strip())[1:-1]]
                     for r in rows]
            h = "".join("<th>%s</th>" % _inline(c) for c in cells[0])
            b = "".join("<tr>%s</tr>" % "".join(
                "<td>%s</td>" % _inline(c) for c in r) for r in cells[1:])
            out.append('<div class="table-wrap"><table><thead><tr>%s</tr>'
                       '</thead><tbody>%s</tbody></table></div>' % (h, b))
            table = []
        if in_list:
            out.append("</ul>")
            in_list = False

    for l in text.split("\n"):
        if l.startswith("```"):
            if code is None:
                flush()
                code = []
            else:
                out.append('<pre class="prcode"><code>%s</code></pre>'
                           % esc("\n".join(code)))
                code = None
            continue
        if code is not None:
            code.append(l)
            continue
        if l.startswith("|"):
            if para or in_list:
                flush()
            table.append(l)
            continue
        if l.startswith("- "):
            if para or table:
                flush()
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>%s</li>" % _inline(l[2:]))
            continue
        if not l.strip():
            flush()
            continue
        if in_list or table:
            flush()
        para.append(l)
    flush()
    return "\n".join(out)


def build(body_path, out_path, values, title, css_path=None):
    """Join the stylesheet and a body template, replace each @@KEY@@ with
    values[KEY], and refuse to write a page with a key left over."""
    css = open(css_path or os.path.join(TEMPLATES, "walkthrough.css")).read()
    body = open(body_path).read()
    page = "<title>%s</title>\n%s\n%s" % (esc(title), css, body)
    for k, v in values.items():
        page = page.replace("@@%s@@" % k, v)
    left = re.findall(r"@@\w+@@", page)
    if left:
        raise SystemExit("unfilled keys: %s" % " ".join(sorted(set(left))))
    with open(out_path, "w") as f:
        f.write(page)
    return page


DEFAULT_PRIVATE = r"(?i)\beap\b|-eap\b|/home/|/Users/|/mnt/|/tmp/"


def check(page, private=DEFAULT_PRIVATE):
    """Print every highlighted and added line per code block, and any
    private-pattern hits. Returns the number of hits."""
    for fig in re.findall(r'<figure class="code">(.*?)</figure>', page, re.S):
        m = re.search(r'<div class="codehead"><span>(.*?)</span>', fig)
        print("##", html.unescape(m.group(1)) if m else "(no caption)")
        for r in re.finditer(r'<span class="ln (hot|add|del)"><span class="no">'
                             r'(\d*)</span><span class="sg">.</span>'
                             r'<span class="tx">(.*?)</span>', fig):
            print("   %-3s %5s  %s" % (r.group(1), r.group(2),
                                       html.unescape(r.group(3)).strip()[:72]))
    hits = re.findall(private, page)
    print("private-pattern hits:", hits or "none")
    return len(hits)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "check":
        pat = DEFAULT_PRIVATE
        if "--private" in sys.argv:
            pat = sys.argv[sys.argv.index("--private") + 1]
        sys.exit(1 if check(open(sys.argv[2]).read(), pat) else 0)
    print(__doc__)
    sys.exit(2)
