---
name: docs-design-pass
description: Raise a repository's charts, figures and prose to the standard of a well-made technical paper for a sophisticated reader, without changing a single measured value. Design counsel first, then a shared style kit, then stacked PRs by area; every rasterized chart gets a phone-readable text alternative generated from the same data; prose is cut to one statement per finding with a number-preservation check; each PR goes through parallel independent review (code review, codex, a rendering visual/data-fidelity reviewer, a cross-doc concision editor), closure passes on the repairs, a red test for every accepted defect, and a merge gate that requires bot reviews of the head and an adjudication on every finding. Use when asked to up-level, restyle or polish graphics, charts, diagrams or docs, to make them look good for a technical audience, to cut useless words, or to make charts readable on mobile.
---

# Docs design pass

The reader is a staff engineer who will check a number against its source and
notice a chart that flatters one side. The work serves that reader: every value
stays exactly what the data says, every comparison says when it is not
like-for-like, and nothing is decoration.

Nothing is pushed, opened or merged without the user's go-ahead for that step.
Push authority is not merge authority.

## 1. Look before advising

- Render every chart to PNG and look at it (light, dark, and at phone width,
  about 390px). Read the generators, the shared style module if there is one,
  and the CI that checks charts.
- Read the docs' openings and longest sections; count words per doc.
- Write the design counsel as a short list of what holds each chart back,
  concretely: saturated fills where a tint would do, the headline in the wrong
  place (a ratio where the measured value belongs), prose inside the figure,
  boxes inside boxes, single-series legends, colliding axis labels, a log axis
  drawn as bars from a floor, colour that implies a winner on a non-ranking
  comparison, inconsistent type between generators.
- For prose: stacked parentheticals, em dashes as a general connector, the same
  caveat in three places, captions that restate numbers, findings retold in
  several docs.
- Name the decisions that are the owner's (e.g. value-first vs ratio-first
  cells; redraw or drop a figure; which docs are in scope) with a
  recommendation for each. Then plan the stack.

## 2. Plan a stack of independently mergeable PRs

1. **Style kit + the charts that share one layout.** Extract the shared
   renderer first (the second copy of a layout loop is the signal), then port
   the charts onto it.
2. **Mechanism figures** on the same kit.
3. **Line/scaling charts** on the same kit.
4. **Prose**, split by doc group so each PR is reviewable; branched from main,
   they do not depend on the chart PRs.

One driver per git worktree. Stacked branches are rebased with
`git rebase --onto <new-parent> <old-parent> <branch>` when a parent is
rewritten; generated outputs (SVG, PNG, doc blocks) are resolved by re-rendering,
never by hand-merging. Figure captions, image embeds and generated blocks belong
to the chart PRs; prose PRs leave them alone, so the two never collide.

## 3. The chart contract

- **The value is the headline.** A heat cell shows the measured value first and
  its standing second (`fastest`, `+N%` inside a near-tie band, `×N`). A ratio
  as the headline hides the number the reader came for.
- **Quiet encodings.** Tints, not saturated blocks; strength may grow with the
  multiple so the ranking still scans. If the PNGs are rasterized by
  ImageMagick's internal SVG renderer, use `rgba()` fills: it ignores
  `fill-opacity` and `opacity`.
- **One type scale, one margin, one footer, one colour per meaning** across
  every generator. A text floor (9px, 11px inside figure boxes): text that does
  not fit at the floor fails the generator instead of shrinking.
- **Contrast in both themes.** Text 4.5:1 against what is drawn behind it,
  marks 3:1 against the page, with the SVG's own dark-mode rules applied.
  `scripts/svg-audit.mjs` checks this; wire it into the repo's tests over every
  committed SVG so a new chart cannot opt out.
- **Colour means one thing.** A series colour must not reuse a heat-ramp hue
  (a reader who knows the heat charts reads it as ×100) or another tool's
  identity colour. A non-ranking comparison gets a neutral tint, never green and
  red.
- **Caveats stay in the figure.** The PNG gets linked and shared on its own. A
  figure that contrasts unlike things (different trees, machines, scopes)
  carries a one-line caveat inside the SVG and in its aria label; the doc
  caption explains the mechanism.
- **Derive, never hardcode.** Axis domains come from the data, the stated
  denominator comes from the comparison axis actually used, figure numbers come
  from the doc. Missing fields throw; a stale dataset must not render a
  plausible cell.
- **The legend lists only the states the chart shows.**

## 4. A text alternative for anything rasterized

A chart scaled to a phone is unreadable, and GitHub's mobile views ignore width
media queries, so a second narrow image does not help. Each generator also
writes the chart's numbers as markdown into the doc that embeds it, inside a
collapsed `<details>`, between markers:

```markdown
![...](bench/charts/name.svg)
<!-- chart-data:name -->
...generated: the chart's context line (versions, machine), then tables...
<!-- /chart-data:name -->
```

The block comes from the same descriptors as the SVG, so they cannot disagree.
CI byte-gates the docs that carry blocks alongside the SVGs, and a doc missing
its markers fails the generator.

## 5. The prose contract

- Lead with the result. One idea per sentence. No marketing words, no hedging,
  no process narration ("we measured", "assumed vs verified").
- Each finding has one owning doc; other docs keep a sentence and a link.
  A caveat is stated once, where it applies; a limitation is never dropped.
- Fairness: where a non-recommended option wins a row, every summary that keeps
  the comparison keeps that win.
- No number changes value. `scripts/numcheck.mjs <base> <doc>...` fails on any
  added number and lists removed ones; each removal must be a repeat the owning
  doc still states, and each addition (e.g. a renamed `12x` → `12×`, or a number
  moved in from its owning doc) is listed with its source field.
- `scripts/linkcheck.mjs` on every doc, with GitHub's slug rules.
- Splitting sentences adds words. If the word count did not fall, the cuts are
  not done; the cross-doc concision review (below) is where the savings are.

## 6. Review: three passes, not a loop

1. **Candidate pass on one frozen commit**, all reviewers in parallel, each
   returning one complete report:
   - `/code-review` on the diff.
   - `codex exec -s read-only` with the PR's contract and an explicit list of
     what to hunt (dropped or changed values vs the old SVG, weakened
     assertions, caveats lost, unbacked claims, CI gate gaps). Run it in the
     background with stdin closed (`codex exec ... </dev/null > log 2>&1`);
     without `</dev/null` it can wait on stdin indefinitely.
   - A **visual and data-fidelity reviewer** agent that rasterizes old and new
     in light, dark and phone width, lists every number in old and new SVGs,
     checks each block against its SVG, and judges the design as an editor of a
     technical publication would.
   - For prose: a codex fact-check of every changed sentence against the data,
     and a **cross-doc concision editor** that assigns an owner to every finding
     retold across docs and returns exact replacements with word savings.
   Deduplicate, classify each finding (blocks this PR / stacked follow-up),
   and fix the batch in one repair.
2. **A red test for every accepted defect**, observed failing on the
   pre-repair code: a kit self-test, an SVG audit over every committed chart, a
   source-level assertion where no runtime test fits. Mutate the fix away and
   watch the test fail. Documentation findings get a corrected text checked
   against the source instead.
3. **Closure pass** on the repair delta: a targeted codex review of exactly the
   repair, then the full render/test sequence on the exact head.

A defect class seen twice (contrast, then contrast again in another generator)
is an architecture finding: fix it once as a shared invariant with a test over
every caller.

## 7. Before every push

- Re-render everything in CI order; the committed SVGs and doc blocks must
  reproduce byte for byte. PNG bytes are not stable across ImageMagick versions;
  re-rasterize and say so in the commit message.
- Formatter clean.
- Scan the diff, every commit message and the PR text for private values
  (early-access model ids, `ANTHROPIC_MODEL`, host names, home paths, account
  names). A hit blocks the push.
- The PR text covers every commit, lists each content correction with its
  source, and states what was reviewed and how.
- A CI job that commits regenerated files back to main conflicts with every
  open PR that touches them, and GitHub then reports "no checks". A checkless PR
  is conflicting until proven otherwise; rebase it, keeping the PR's render.

## 8. The merge gate

No PR merges until every finding is adjudicated and the bots have reviewed the
exact head:

- Request `@codex review` and `@coderabbitai review` on the head. A review of an
  earlier head covers nothing; re-request after every push. A green CodeRabbit
  status can mean "review skipped"; read its comment.
- Answer every finding with a reply that opens with one of:
  `RED-VERIFIED: <test>` (a defect, closed by a test watched failing without the
  fix), `NOT-A-DEFECT: <reason>` (docs, naming, style; give the corrected text
  and its source), or `DISAGREE: <evidence>` (a claim rejected with data; e.g. a
  bot quoting a stale external limit gets the live page quoted back). Resolve
  the thread after answering.
- Run the repository's gate script (for example `make review-gate PR=<n>`)
  before calling a PR ready; CI posts the same verdict as a required status.
- Report the PR ready. Merge only when the user authorizes that merge.

## Files

- `scripts/svg-audit.mjs`: legibility audit (text size, text and mark contrast,
  both themes). `node svg-audit.mjs [--min-text 9] [--min-box-text 11] *.svg`,
  or import `auditSvg` into the repo's test.
- `scripts/numcheck.mjs`: number-preservation check for prose edits.
- `scripts/linkcheck.mjs`: relative-link and anchor checker, GitHub slug rules.
