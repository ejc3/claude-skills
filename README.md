# claude-skills

Skills for [Claude Code](https://docs.claude.com/en/docs/claude-code). Each
directory is one skill: a `SKILL.md` with its instructions, and any scripts or
templates it uses.

| Skill | What it is for |
|---|---|
| [`pr-diligence`](pr-diligence/SKILL.md) | Preparing a pull request someone else will judge, such as a fix sent upstream: a red/green regression test in the builds the project's CI uses, a fix no bigger than the defect, parallel independent review of a frozen packet, a private-value scan, plain PR text, and a public walkthrough page of the code generated from git. |

## Install

Clone the repository and link the skills you want into `~/.claude/skills`:

```sh
git clone https://github.com/ejc3/claude-skills ~/claude-skills
ln -s ~/claude-skills/pr-diligence ~/.claude/skills/pr-diligence
```

Claude Code picks up skills in `~/.claude/skills` at the start of a session.

## pr-diligence: the walkthrough helper

`pr-diligence/scripts/walkthrough.py` builds a walkthrough page from git, so
every code excerpt is exactly what the branch contains. Write a small generator
per pull request:

```python
import sys; sys.path.insert(0, "/path/to/pr-diligence/scripts")
from walkthrough import Repo, text_block, markdown, build, check

r = Repo("~/src/project")
page = build("pr-diligence/templates/body.html", "walkthrough.html", {
    "DIFF": r.diff("upstream/master", "fix-branch", "menu.c", marks={203: 1}),
    "CAUSE": r.excerpt("upstream/master", "menu.c", 194, 202, hot=[200]),
    "PRBODY": markdown(open("pr.md").read()),
    # ... every @@KEY@@ in the body template
}, title="Menu dead-pane fix")
check(page)   # prints each highlighted line and any private-pattern hits
```

Line numbers given to `excerpt()` and `diff()` are the file's own. `build()`
refuses to write a page with a key left unfilled.
