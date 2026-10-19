---
name: pr-diligence
description: Prepare a pull request that someone else will judge, usually a fix sent to another project's maintainer, with the diligence that gets it taken. A regression test observed failing on the base and passing with the fix, in the builds the project's CI uses; a fix no bigger than the defect; a frozen review packet checked by parallel independent reviewers, then closure passes on the repairs; a scan for private values; plain PR text where every claim is checked; and a public walkthrough page of the code, generated from git and linked from the PR. Also how to land a stack of PRs through its top PR, with GitHub's native stacked PRs (`gh stack`). Use when sending a fix upstream, opening a PR to a project you do not own, landing a stack of PRs, or when the user asks for a careful, reviewed, or walked-through pull request.
---

# PR diligence

A pull request to someone else's project is judged by a reader who owes you
nothing and who will run your test before trusting your words. Everything here
serves that reader: one defect per PR, proof that the test catches it, a change
no larger than the defect, text with no claim the reader can refute, and a page
that walks through the code for anyone who wants more than the diff.

Nothing is pushed, opened, posted or made public without the user's go-ahead
for that specific PR. Push authority is not merge authority, and approval for
one PR does not cover the next.

## 1. Know the receiving project first

Before writing anything, read:

- `CONTRIBUTING`, the PR template, any AI-assistance policy, and the style guide
  the project uses (e.g. OpenBSD style(9)).
- The CI workflow: which builds it runs (sanitizers, platforms) and when it runs
  (on PRs, nightly, on demand). Build your evidence the same way.
- Ten or more recently merged and closed fix PRs, with the maintainer's comments.
  Note what they apply as is, what they rewrite, which tests they keep or drop,
  how long accepted texts are, and what they ask ("I ran your test on master
  without your fix and it passes").
- How the existing tests are written, so a new test looks like its neighbours.
  Put new cases into an existing test file when one covers the area.
- What the maintainer changed in your earlier PRs to this project that were
  applied, and the notes kept from them (section 9).
- Open PRs and issues that touch the same functions, and whether the base branch
  has moved. Rebase onto the current base; say which base the evidence is for.

Claims about what the maintainer wants need evidence (a commit, a comment).
A reviewer's assertion about the project, the account or the maintainer is a
lead to check, not a fact to repeat.

## 2. Shape each PR

- One defect per PR. Independent fixes go in separate PRs, each on the base
  branch, so each can be taken alone.
- Two commits: the regression test first, then the fix. The test commit must
  fail on the base; the fix commit makes it pass.
- The fix changes only what the defect needs. If a line changes behaviour that
  is not the defect, it does not belong, however reasonable it looks. (A memory
  fix that also "corrected" a cursor column overwrote text; the reviewers
  caught it twice.)
- Follow an idiom the codebase already uses for the same problem, and cite it.
- When a nearby condition already takes the same action (the same `break` or
  `return`, with nothing between them that the new case needs), add the new
  case to it instead of writing a second `if`. (A guard written as its own
  `if`, `break` and four-line comment was applied as one `||` in the existing
  check above it, with the comment dropped.)
- Keep comments as few and as short as those around them. A maintainer may
  drop a comment, or rewrite one that explains why into one that says what the
  code does ("The cursor may have been saved on a taller screen." became
  "Clamp cursor to the current screen size."). Put the full reasoning in the
  PR text, which stays linked from the project's history.
- Commit messages describe what is in the diff: the symptom, the cause in the
  code's own identifiers, the fix. Expect the maintainer may keep only the
  first line, or write their own; do not rely on the body surviving.
- Write the test so it can be applied as it stands: it lives in the project's
  test directory, needs nothing from the fix commit but the fix, and reads like
  the tests beside it. A maintainer may apply all your tests later, in a
  commit of their own, separate from the fixes.

## 3. Prove it, red then green

For every PR:

1. Build the base and the branch the way the project's CI does (for C: a plain
   build and a sanitizer build). Confirm each build is what you think it is: for
   a sanitizer build, check the binary actually contains the sanitizer
   (`nm tmux | grep -c __asan_report`). In zsh an unquoted `$args` is one word,
   so `./configure $args` silently fails; build from a bash script with an array.
2. Run the new test at least five times against each of: base plain, base
   sanitizer, fix plain, fix sanitizer. Record exit codes and the first lines of
   output. Run it the way the suite runs it (e.g. under `env -i`).
3. Read why it fails on the base. The failure must be the stated defect (the
   sanitizer's function and kind of error), not a harness timeout or a missing
   tool. If a case only shows under a sanitizer, say so in the text.
4. Reproduce the bug independently of the test, from the description alone,
   and try the real-world trigger you intend to name. If you cannot trigger it
   that way, do not claim it.
5. Run the full suite on the base and on every branch, in both builds. Every
   failure on a branch must also fail on the base or be shown to be load-related
   by rerunning it alone; say which in the text. Run many suites in parallel
   only with separate socket/temp directories per run.
6. Every accepted defect claim from review gets a test case observed failing
   without the fix.

Test-writing rules learned the hard way:

- Do not depend on an ordering the platform does not guarantee (signal delivery
  order differs between event backends; send the signal that must come first,
  first).
- A readiness barrier must not itself queue work that changes the outcome (a
  "resize until attached" loop left a resize pending and let the base pass).
- Do not add harness the project removed (forced leak checking, log files):
  let the sanitizer's abort be the failure.
- Bound every wait. Fail with a message that names what died or timed out.
- A test that stops at its first failure hides the later cases; report each.

## 4. Review campaign

Reviews run on a frozen packet, never on a moving tree, and every reviewer
returns one complete report.

**Packet.** `git format-patch` per branch, the PR texts, and a `BRIEF.md` that
states: the base and branch heads, where built binaries are, how to run tests,
what the receiving project expects, hard rules (never touch the user's own
processes or servers, use private sockets, no `pkill -f`, do not modify the
worktree, post nothing), where scratch goes, and the output format: each
finding with location, evidence (command and output, or source lines), a
suggested change, and a class: BLOCKS, FOLLOW-UP or NIT. "No findings" is a
valid result.

**Reviewers, in parallel, each with a different job:**

- A different model (e.g. `codex exec -s read-only ... < /dev/null`) for source
  correctness and portability.
- Code correctness and style: other call sites with the same defect, side
  effects, edge cases run on the binaries, the project's style rules.
- Maintainer lens: how this maintainer handles such PRs, with links; what they
  would cut; whether the test is the kind they keep.
- Fresh-eyes text: every sentence of the PR texts and commit messages, read by
  someone who has seen none of the work.
- Reproduce or refute: assume every claim is wrong until it has been run.

Wait for all of them. Deduplicate, classify each finding (blocks this PR, or a
follow-up the PR does not rely on), and repair the batch at once. The second
instance of one defect class means the model was wrong: change the shape, not
the call site. Then run the full suite once on the repaired heads, freeze them,
and send only the repair deltas (`git range-diff`) to a closure review. At most
three broad passes; after that, targeted checks only.

## 5. Write the PR text

- Lead with what goes wrong, then the cause in the code's identifiers, then the
  fix, then the test, then Testing.
- Plain and first person. No selling, no reassurance, no explaining the
  maintainer's own code beyond what the argument needs.
- Every factual claim is checked: line numbers, function names, values printed
  by the base (label platform-specific values: "on arm64"), and what was not run
  ("Not run on macOS or OpenBSD").
- A copy-paste reproducer when one exists, checked by running it.
- The Testing section gives the environment, the red/green runs and the full
  suite result.
- If AI helped, end with the project's disclosure, e.g. "Written with Claude's
  assistance; I have reviewed it and can explain it." That sentence is the
  user's attestation: they must read the code before it is posted.

## 6. The walkthrough page

A public page per PR that walks a reader through the code. Link it from the PR
text, just before Testing.

**Sections**, in this order (skeleton in `templates/body.html`):

0. What goes wrong: a short timeline, a reproducer, the sanitizer report
   trimmed to the frames that matter, what an ordinary build does.
1. Where the bad value comes from: the path through the code, one excerpt per
   step, each from the base revision with the key lines highlighted.
2. The change: the real diff with numbered callouts; what does not change; the
   same idiom elsewhere in the codebase.
3. Why the new check is safe, when that is not obvious.
4. The test, explained by line number.
5. Evidence: a table of base versus fix, and the environment.
6. The PR text as GitHub shows it, the raw Markdown, the commit messages, and
   the design questions a maintainer is likely to ask, answered briefly.

**Generate it from git.** Write a small per-PR generator with
`scripts/walkthrough.py`: `Repo.excerpt()` and `Repo.diff()` take the file's own
line numbers (never offsets), `markdown()` renders the PR text,
`build()` refuses to write a page with an unfilled key. Then run
`walkthrough.py check page.html` and confirm every highlighted line is the one
the prose points at, and that no private pattern matches.

**Write for the public.** The page speaks about the change, not about you or
your process: no review history, no "the maintainer would", no "you". Footer:
"Written with Claude's assistance. The code shown is generated from the branch."

**Publish order.** Publish the page (private), add its link to the PR text,
regenerate so the page's own copy of the PR text includes the link, republish,
and ask the user to read it and make it public. Only then open the PR. After
opening, regenerate with the PR number in the header and republish.

## 7. Nothing private gets out

Before every push and every PR:

- Check visibility: `gh repo view OWNER/REPO --json visibility` for the fork and
  the target.
- Scan the diff, every commit message, the PR text and the walkthrough page for
  private values: early-access model names (anything matching `eap`), the
  session's own model id, host names, local paths, account and profile names.
  Use made-up placeholders in tests and examples. A hit blocks the push.
- Commit with the user's public (e.g. noreply) identity.

## 8. Ship one PR

On the user's go-ahead for that PR:

1. Fetch the base; confirm the branch is still on it and nothing new overlaps.
2. Run the private scan on the exact branch and text.
3. Confirm the fork has no branch of that name, then push.
4. `gh pr create --repo TARGET --base BASE --head FORK:BRANCH --title "<first
   line>" --body-file <the rest>`. Never retype the text.
5. Read the PR back: title, commits, head SHA, mergeable state, and the body
   diffed against the file. Note which checks run (some projects run CI only
   nightly).
6. Update the walkthrough with the PR number, and record the state where the
   next session will find it.
7. Report the link and stop. The next PR waits for the user.

## 9. After it lands

When the maintainer applies a PR, compare the patches, not the trees: the base
has moved, so a tree diff shows upstream's changes as well. Use
`git range-diff`, or diff `git show <your fix commit>` with
`git show <landed commit>`, ignoring lines the project changes on every commit
(an RCS id, a version stamp). Do the same for the tests.

Write down each edit the maintainer made (code, comments, wrapping, commit
message, which tests they kept) in notes on that project that the next session
will find, such as its memory, and read them in section 1. Add a rule to
section 2 only when it is more than one maintainer's taste: the same edit seen
from more than one project, or a plain case of matching the code around it.
Otherwise it is a fact about that project.

## Stacks of PRs in one repository

Work too big for one PR goes in a stack: each PR's base is the branch of the PR
below it, and the bottom one targets the trunk. GitHub supports stacks natively
(the `gh stack` extension, `gh extension install github/gh-stack`), and landing
the top of a stack lands the whole stack. All the branches must be in one
repository, so a stack cannot include a PR from a fork.

- **Turn existing PRs into a stack** with `gh stack link 101 102 103`, bottom
  to top (numbers, URLs or branch names). It needs no local stack state. It
  pushes branch arguments, creates PRs that are missing, and corrects the base
  of any existing PR that does not match the chain. To start a stack from
  scratch, use `gh stack init`, `add` and `submit`.
- **Land through the top.** `gh stack merge <top-pr> --rebase` merges that PR
  and every unmerged PR below it, bottom-up, in one operation. The checks
  before it are all-or-nothing: if any PR fails them, none merges. A failure
  during the merge stops it at that PR, though. The PRs below it stay landed,
  and that PR and the ones above stay open. Afterwards, check every PR's state;
  to continue, fix the failed PR and merge again.
  Landing a mid-stack PR also lands the PRs below it, and the PRs above
  retarget to the stack's base. A PR in the middle cannot land alone.
  - A bare number is read first as a stack number, then as a PR number. The two
    never overlap.
  - `--yes` merges every PR in the stack without a prompt. Use it only with the
    user's go-ahead for the whole stack, naming the PRs it will land.
- **Requirements apply to every PR in the stack,** not only the top. Branch
  protection, approvals and CODEOWNERS are enforced on each PR, every PR below
  the top needs passing checks, and the history must be linear. After a lower
  branch changes, run `gh stack rebase` and then `gh stack push`. `gh stack
  sync` rebases only when the trunk has moved, so it leaves the upper branches
  stale after a change lower down. `gh stack merge` cannot bypass requirements, and auto-merge
  is not supported for stacks.
- **With a merge queue,** `gh stack merge` only enqueues the stack. The queue
  picks the merge method, so `--rebase` is ignored. The PRs may land in
  separate groups, and ejecting one also removes every PR above it. Watch the
  queue, not the command's exit status.
- **Pin the heads.** `gh stack merge` has no `--match-head-commit`. The
  asynchronous merge API takes the top's head SHA and cancels the merge if that
  head moves first: `gh api -X PUT
  repos/<owner>/<repo>/pulls/<top>/merge-async -f sha=<top-sha>
  -f merge_method=rebase`. A 202 answer only means the request was accepted.
  Take the `uuid` it returns, then poll
  `gh api repos/<owner>/<repo>/pulls/<top>/merge-async/<uuid>` until the status
  is `merged`, `enqueued` (in a merge queue, not yet merged) or `failed`
  (with a message). It stays `pending` while the merge runs. That pins only the
  top. Just before merging, also check that each lower head
  is an ancestor of the top, and that CI ran on those exact SHAs.
- **Review once, on the cumulative diff.** Each PR shows only its own layer, so
  a review of the top PR's diff covers only the top layer. Run the expensive
  gates (the full suite, perf, the head review) once, on the whole range
  `trunk..top-head`, and fix findings in one batch on top. That saves a round
  per layer.
  - A cumulative pass can miss a defect that a lower layer adds and a higher
    one removes. And a merge that stops partway leaves the lower layers on the
    trunk on their own.
  - So every layer must still pass the repository's required checks at its own
    head, which GitHub enforces on each PR.
  - Whatever else the repository requires of each PR (approvals, resolved
    threads, a description line) is still required of each one.
- **A chain not registered as a GitHub stack** can land the same way by hand.
  Every lower PR must already have passed its own required checks and
  approvals. Retarget the top to the trunk, run
  `gh pr merge <top> --rebase --match-head-commit <sha>`, and close the PRs
  below with a pointer to the landed range. Do not retarget the top of a
  registered stack, because that breaks the chain.
- **Before deleting a branch,** run `gh pr list --base <branch>` and retarget
  each PR found there. GitHub documents that deleting a merged PR's head branch
  retargets the PRs based on it. Still, a PR left on a deleted base can end up
  closed, and one was, after a rebase merge.

Docs: [About stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs),
[Merging stacked pull requests](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests),
[CLI commands](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands).

## Working habits

- Long builds and suites run in the background with output to a file; read the
  file when they finish.
- Scratch files go in the checkout's `.scratch/` (git-ignored); large builds go
  on a scratch disk.
- Say what was verified and what was not. When a reviewer, a tool or your own
  earlier message turns out wrong, say so plainly and fix it.
