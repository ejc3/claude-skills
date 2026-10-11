---
name: pr-review-gate
description: "ALWAYS USE THIS SKILL when: a PR has review findings (Codex, a bot, or a human), before resolving any review thread, before calling a PR green, and before merging. Enforces that a defect claim is closed by a test that fails without the fix (RED-VERIFIED), not by the fix alone. Invoke with /pr-review-gate"
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
---

# Adjudicating PR review findings

## Quick Reference

| Task | Command |
|------|---------|
| Check threads (this gate) | `.claude/skills/pr-review-gate/check-review-threads.sh <N>` |
| Read inline findings (Codex) | `gh api --paginate repos/$REPO/pulls/<N>/comments --jq '.[] \| "---\nfile: \(.path):\(.line // .original_line)\n\(.body)"'` |
| Read PR-level review bodies | `gh api --paginate repos/$REPO/pulls/<N>/reviews --jq '.[] \| "---\n\(.user.login) \(.state)\n\(.body)"'` |
| Trigger a Codex review | `gh pr comment <N> --body "@codex review"` |
| Prove checks exist, not just pass | see "Prove the checks EXIST" below |
| Merge | `gh pr merge <N> --squash` (branch auto-deletes) |

**Setup** — once per session:
```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
```

---

Merging here is gated on review-thread resolution. That gate can tell you a thread is
*resolved*; it cannot tell you the finding was *answered*. This skill is how you answer
one.

## The rule: a defect claim is closed by a RED test, not by a fix

**Whenever anyone — Codex, a bot, a teammate, you — says "this is broken", the thing that
closes it is a test that FAILS WITHOUT THE FIX.** Not the fix. Not "verified manually".
Not a green suite after the change, which proves only that the suite never covered it.

Applies to every source of a defect claim, not just review comments: a CI failure, a bug
report, a hunch, a comment you wrote yourself.

**The procedure, in order:**

1. Write the test. Run it against the **unfixed** tree. **Watch it fail.**
2. Apply the fix. Watch it pass.
3. Revert the fix once more and confirm it goes red again — if you skipped step 1, this
   is your last chance to learn the test was vacuous.
4. Only then resolve the thread, replying `RED-VERIFIED: <test name or path>`.

A test written after the fix, never observed failing, is indistinguishable from a test
that cannot fail.

### Within reason

Use judgement about scope. This rule exists to stop **behavioural** defects closing on an
assertion — a dropped record, a wrong total, a silent failure. It is not a demand for
ceremony around every finding.

Where a red test is disproportionate — a typo, a rename, a doc or config line, a one-line
guard whose absence is self-evident — answer with `NOT-A-DEFECT: <what you changed>` and
move on. Where the defect is real but a test would cost more than the bug (a rate-limited
API path, a 100-item fixture for an off-by-one), say so plainly in the disposition and
describe how you checked it by hand. An honest "verified this way, not by a test" is worth
more than a test written to satisfy a rule, which tends to be a test that cannot fail.

The judgement call is *yours*, and the disposition is where you record it. What is not
optional is answering — silence, or resolving a thread with no reply, is the thing the gate
exists to catch. That is not hypothetical: this rule comes from `ejc3/fcvm`, which
repeatedly found checks that could never fire — a leak check whose pattern never
matched, a `grep '^ *FAIL'` blind to the runner's actual failure format, a branch logged
0 times across 137 runs. Every one was green for its whole life.

The trap is live in any stack. A Jest suite passes happily when `moduleNameMapper`
points at a file that does not exist yet; `pytest` reports success on a file it never
collected. Watching the test fail first is what separates "this is covered" from "this
looks covered".

**Every resolved thread needs one of three dispositions as a reply.** The gate does not
try to guess which findings are defects — guessing failed in both directions, letting
ordinary phrasing like "this drops the final game" close on an assertion, while making a
*wrong* defect claim impossible to ever close. Answer each one instead:

| Disposition | Use for |
|---|---|
| `RED-VERIFIED: <test>` | a defect claim, closed by a test you watched fail without the fix |
| `NOT-A-DEFECT: <reason>` | naming, docs, style — say what you changed |
| `DISAGREE: <reason>` | a defect claim you are rejecting, with the reasoning |

Disagreement is a legitimate resolution; silence is not. Three rules, each of them a hole
the gate once had:

1. **A disposition OPENS a reply of its own.** Not buried mid-sentence, not appended to
   prose. Matched anywhere in the text, "Please add `RED-VERIFIED: <test>` before
   resolving" counted the reviewer *demanding* evidence as the person supplying it.
2. **The text after the colon must be non-empty.** A bare `RED-VERIFIED:` is a placeholder.
3. **An answer must be NEWER than the claim it answers**, for PR-level findings. Inside a
   thread the rule is only that a disposition exists: a positional version was tried and
   withdrawn because it could not tell a new defect from "Thanks, confirmed", and blocked
   adjudicated threads.
4. **A finding counts wherever it lands** — inline thread, review body, or a plain
   top-level PR comment. But your OWN comments and bot notifications are not findings;
   otherwise `@codex review` blocks the PR it was posted to trigger. The last was invisible to the gate for a while, so a claim posted
   with `gh pr comment` — the command these docs recommend — could sit on a PR reporting
   CLEAR.

## Check the threads

```bash
.claude/skills/pr-review-gate/check-review-threads.sh <pr-number>
```

The gate has its own tests — `test-check-review-threads.sh`, one case per past failure,
each written against the unfixed script and observed failing first:

```bash
.claude/skills/pr-review-gate/test-check-review-threads.sh \
  .claude/skills/pr-review-gate/check-review-threads.sh
```

Exit codes: `0` clear, `1` blocked (unresolved threads, or a resolved defect claim with
no `RED-VERIFIED` reply), `2` the gate could not evaluate — treat 2 as blocked, never as
a pass.

It flags three things:

- **UNRESOLVED** — a finding nobody has answered. Not a finding that is wrong.
- **UNDISPOSED** — a resolved thread with no disposition reply. Resolving without
  replying closes a finding without answering it.
- **UNANSWERED** — a PR-level **review body** carrying no disposition. A defect claim can
  arrive in the review body rather than an inline comment; that is not a thread, has no
  "resolved" state, and never appears in `reviewThreads`. Answer it by posting a review
  on the PR opening with one of the same three dispositions, dated after the finding.
  A bare acknowledgement used to be enough here, which meant an identical claim was
  adjudicated or waved through depending only on where the reviewer happened to click.

It also blocks when it cannot trust its own input: a PR number that does not resolve, a
thread whose `isResolved` is not a boolean, malformed review data, a non-empty review body
with no timestamp, or a missing `jq`/`gh`. Those exit `2`. There are no `|| echo 0`
fallbacks left — a `jq` failure must never read as "nothing to answer".

## Prove the checks EXIST before trusting green

"No failures" is not "it passed". A check set can be green because nothing ran.

```bash
SHA=$(gh api repos/$REPO/pulls/<N> --jq .head.sha)
gh api --paginate repos/$REPO/commits/$SHA/check-runs \
  --jq '.check_runs[] | select(.conclusion != "skipped") | "\(.name)\t\(.conclusion)"' | sort -u
```

Expect both `review decision` and `review-gate (self-test)`. **A job missing from
that list is a failure to verify, not a pass.** `--paginate` matters: the first page holds
30 runs, so without it a required job can be missing from the output while present on the
PR — turning the "prove the checks EXIST" step into a coin flip on a busy commit.

In `ejc3/fcvm` a PR merged on a "no failures" reading whose head sha had **zero** runs of
the real jobs: a `pull_request: branches: [main]` filter silently skipped the workflow
for every PR whose base was not `main`, and the only check that ran was an unrelated one.
It carried three lint violations.

`ci.yml` here uses a bare `pull_request:` trigger with **no `branches:` filter** so
stacked PRs are covered. Do not add one.

## A gate must fail closed

A check that cannot run must **block**, never pass. Passing is a claim, and a tool that
could not evaluate anything has no basis for making it. If a dependency is missing, the
input is malformed, or the API is unreachable, exit non-zero — never default to clear. A
gate that waves everything through precisely because it broke is strictly worse than no
gate, because it looks like one.

This applies to your own verification too: if you could not run the check, say so. Do not
report a verdict you did not earn.

## Before you merge

1. Every thread resolved **and disposed** (`RED-VERIFIED:` / `NOT-A-DEFECT:` / `DISAGREE:`).
2. Every PR-level review body answered with a disposition, posted after it.
3. Both required checks present **and** passing.
4. No conflicts with `main`. Being up to date is not required; the CI run on `main` after
   the merge is the backstop.
5. Squash-merge; the branch deletes itself.

Run `check-review-threads.sh <N>` to confirm 1 and 2 rather than eyeballing them.

Comment paging cannot be covered by `--from-file` fixtures — they contain every comment
inline, so they pass with or without it. `probe-pagination.sh` verifies that path against a
real PR with `COMMENTS_PAGE_SIZE=1`, putting the disposition at comment #2 of 3 (the middle)
and comparing three strategies: first-page-only must MISS it, first-page-plus-last-page must
MISS it too, full cursor paging must SEE it.

Building a long thread honestly costs 100+ comment-creation calls, which GitHub
secondary-rate-limits into silent partial failure — a first attempt asked for 105 replies,
silently got 39, and would have "passed" for an unrelated reason. Shrinking the page is what
makes the real code path cheap to exercise; the probe asserts its setup exists before
judging anything.

## Merging is not the finish line — check that the head was reviewed

The gate blocks when reviews exist but none covers the current head commit. This exists
because this very skill shipped with five open findings: the branch was pushed, the prior
round was answered, the gate went CLEAR, and it merged 36 seconds later while the reviewer
was still working. Its findings landed five minutes after the squash.

Nothing was bypassed. Answering every finding proves nothing if nobody has reviewed the
code you are about to merge. After your last push, wait for the review of *that commit*.

**Updating the branch does not cost you the review.** The ruleset no longer requires a
branch to be up to date, but a branch still gets updated to resolve a conflict or pick up a
change it depends on — and that moves the head out from under every review, which once
left the up-to-date rule and the coverage rule deadlocked. `same-change.sh`
compares what the PR proposes at the reviewed commit and at the head by patch id; when
they are identical, as they are after a merge of the base and nothing else, the review
carries forward and the gate says which commit it carried from. A merge that also
changed a file is a different patch and still blocks, which is the case that matters.

Three things about coverage that are not obvious:

- **Codex reports coverage in a COMMENT, not always a review.** When it finds nothing it
  submits no review at all — it posts a top-level comment naming the commit it read
  (`**Reviewed commit:** \`95d4d60a70\``). The check reads that marker, because against
  the only reviewer this repo has it could otherwise never fire: `anyreview` was 0, the
  block skipped itself, and an unreviewed head printed CLEAR.
- **A security pass is not a code review.** The security result carries the same
  `**Reviewed commit:**` footer. Only a completed *code* review counts as coverage —
  `COVERAGE_VERDICTS` is a strict subset of `CONNECTOR_VERDICTS` for that reason, and
  "Something went wrong" is excluded too: it reports that the review failed.
- **A base-merge moves the SHA, not the content — and the gate cannot tell.**
  `gh pr update-branch` creates a merge commit, so the head changes while the PR's own
  diff does not. The gate compares commit ids and has no access to git (it must also run
  against `--from-file` fixtures), so it will report `UNREVIEWED HEAD` for a head that is
  byte-identical in content to the reviewed one. **That is a known false positive**, and
  the only one this gate has.

  Confirm it is that case before merging past it — never assume. FAIL CLOSED: if either
  revision is missing (force-push, shallow clone), `git diff` dies but a bare
  `| git hash-object --stdin` still hashes the EMPTY input — both sides print
  `e69de29...` and "same hash" falsely certifies an unreviewed head. Verify the
  revisions and stop on any failure first:

      set -o pipefail
      git cat-file -e "$REVIEWED^{commit}" && git cat-file -e "HEAD^{commit}" || exit 1
      a=$(git diff "$(git merge-base main "$REVIEWED")".."$REVIEWED" | git hash-object --stdin) || exit 1
      b=$(git diff "$(git merge-base main HEAD)"..HEAD | git hash-object --stdin) || exit 1
      [ "$a" = "$b" ] && echo "review still covers this content" || echo "genuinely unreviewed"

  Same hash proves the PR's OWN changes are the reviewed ones — it does NOT prove the
  integration is: a base merge can change code the patch depends on while the patch
  hash stays identical (Codex reproduced this with a base-only dependency change). So
  the escape is two conditions, not one:

      git diff --name-only "$(git merge-base main HEAD)"..HEAD > /tmp/pr_files
      git diff --name-only "$REVIEWED"..HEAD -- $(cat /tmp/pr_files) | grep -q . \
        && echo "base merge touched the PR's own files — fresh review required"

  Same patch hash AND the base merge touched none of the PR's files → merging is
  correct; say so in the PR. Anything else — different hash, overlapping base changes,
  any command failing → treat as unreviewed and wait for a fresh review.

  Order the work so this comes up rarely: **update the branch first, then request the
  review, then merge without touching it again.** Chasing a fresh review after every
  rebase is what makes people merge past the verdict — which is how one PR merged on a
  `BLOCKED` reading, correctly as it turned out, but for no better reason than impatience.

## What the gate can and cannot know about a bot's comment

It reads the connector's **verdict line** — its own declaration that it is not asking for
changes — exactly as it trusts GitHub's `APPROVED` state. This does **not** prove the body
carries no finding, and `APPROVED` never proved that either.

Six earlier attempts stripped known boilerplate and matched what remained. Every one
leaked, because anything deleted before matching is a place to hide a finding: a claim on
the same line as the notice (three separate patterns), a claim in an "any plain sentence"
pleasantry, a claim between two `<details>` blocks that a greedy strip spanned, a claim
inside a code fence. Whole-body enumeration fails too — the pleasantry is model-generated
and produced seven variants in one evening.

If a new connector message blocks a PR, the fix is a disposition reply, or one literal
added to `CONNECTOR_VERDICTS`. It is not another pattern.
