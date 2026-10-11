# AGENTS.md — claude-skills

Rules for AI coding agents working in this repository. `CLAUDE.md` is a
symlink to this file so Claude Code reads the same instructions.

## What this is

Published skills for Claude Code. Each top-level directory is one skill: a
`SKILL.md` with YAML frontmatter (`name`, `description`) and any scripts or
templates it uses. List every skill in the README table. `.claude/skills/`
holds this repository's own tooling (the review gate below), not published
skills.

## This repository is public

Never write an account id, zone or project id, internal hostname, secret name
or value, email address, person's name, or any other identifier from a real
deployment into a file, a commit message, or a pull request title, description
or review comment. Use placeholders (`<site>`, `example.com`,
`example-profile`). Generic product names and public documentation links are
fine. Check the diff, the commit messages and the PR text before every push.

## Pull requests

- All changes land via pull request; do not push directly to `main`.
- Every PR conversation must be resolved before merging.
- No reviewer approval is required — the author may merge once conversations
  are resolved and checks pass. **That makes `/code-review` the only review a
  substantive change gets.**

### Run `/code-review` and `/simplify` on a diff that matters

Run them before merging anything that:

- changes a script or template a skill ships, or a workflow under `.github/`
- changes what a skill tells an agent to do (its steps, commands or rules)
- adds a skill
- you catch yourself describing as "should be fine"

`/code-review` hunts correctness bugs (in a skill, that includes claims that
are not true and commands that do not work). `/simplify` hunts duplication,
wasted work and fixes applied at the wrong altitude.

### The PR has to say which you chose

CI fails unless the pull request description carries exactly one line for each
of these, decided separately:

```
Code-Review: ran          |  Code-Review: skipped — <reason>
Simplify: ran             |  Simplify: skipped — <reason>
```

`.github/pull_request_template.md` pre-fills both pairs; delete the lines that
do not apply. Leaving a pair intact, or a bare `skipped` with no reason, fails
— an unedited template must not satisfy the gate. Tokens inside HTML comments
and code fences are ignored for the same reason. The check is
`review decision` (`.github/workflows/review-decision.yml`); it re-runs when
the description is edited.

Skipping either is a good answer for a typo, a revert or a wording tweak. The
reason is the point: it is the difference between a decision and an omission.

### Answer every review finding

Before resolving a thread or merging, follow the `pr-review-gate` skill
(`.claude/skills/pr-review-gate/SKILL.md`): every resolved thread carries a
reply opening with `RED-VERIFIED:`, `NOT-A-DEFECT:` or `DISAGREE:`, and
`check-review-threads.sh <pr-number>` must report CLEAR (exit 0) before the
merge.

### The gate tests itself

`review-gate (self-test)` in `.github/workflows/ci.yml` runs every
`test-<script>.sh` in `.claude/skills/pr-review-gate` against its subject and
fails unless each suite actually executed cases. A new script there gets a
`test-` file beside it; the pairing is the list.
