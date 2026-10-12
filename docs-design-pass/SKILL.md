---
name: docs-design-pass
description: Use when asked to up-level, restyle or polish a repository's charts, figures, diagrams or docs for a technical audience, to cut useless words, or to make charts readable on mobile. Raises them to the standard of a technical paper without changing a measured value.
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
- Write the design counsel as a short list of what holds each chart back
  against the chart contract (§3) and each doc against the prose contract (§5),
  concretely, one finding per defect.
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

One driver per git worktree. Stacked branches are rebased onto the new parent
when a parent is rewritten (the command is under Files); generated outputs
(SVG, PNG, doc blocks) are resolved by re-rendering, never by hand-merging.
Figure captions, image embeds and generated blocks belong to the chart PRs;
prose PRs leave them alone, so the two never collide.

A CI job that commits regenerated files back to main conflicts with every open
PR that touches them, and GitHub then reports "no checks". A checkless PR is
conflicting until proven otherwise; rebase it, keeping the PR's render.

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
  The legibility audit (svg-audit) checks this; wire it into the repo's tests
  over every committed SVG so a new chart cannot opt out.
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
- **The legend lists only the states the chart shows.** No boxes inside boxes,
  prose inside the figure, single-series legends, colliding axis labels, or a
  log axis drawn as bars from a floor.

## 4. A text alternative for anything rasterized

A chart scaled to a phone is unreadable, and GitHub's mobile views ignore width
media queries, so a second narrow image does not help. Each generator also
writes the chart's numbers as markdown into the doc that embeds it, inside a
collapsed `<details>`, between markers:

```markdown
![...](bench/charts/name.svg)
<!-- chart-data:name -->
<details>
<summary>The chart's numbers as tables</summary>

...generated: the chart's context line (versions, machine), then tables...

</details>
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
- No number changes value. The number-preservation check (numcheck) fails on
  any added number and lists removed ones; each removal must be a repeat the
  owning doc still states, and each addition (e.g. a renamed `12x` → `12×`, or a
  number moved in from its owning doc) is listed with its source field.
- The link check (linkcheck) runs on every doc, with GitHub's slug rules.
- Cut stacked parentheticals, em dashes as a general connector, the same caveat
  in three places, captions that restate numbers, and findings retold in
  several docs.
- Splitting sentences adds words. If the word count did not fall, the cuts are
  not done; the cross-doc concision review (below) is where the savings are.

## 6. Review: three passes, not a loop

1. **Candidate pass on one frozen commit**, all reviewers in parallel, each
   returning one complete report:
   - `/code-review` on the diff.
   - `codex` in read-only mode with the PR's contract and an explicit list of
     what to hunt (dropped or changed values vs the old SVG, weakened
     assertions, caveats lost, unbacked claims, CI gate gaps), run in the
     background with stdin closed (see Files).
   - A **visual and data-fidelity reviewer** agent that rasterizes old and new
     in light, dark and phone width, lists every number in old and new SVGs,
     checks each block against its SVG, and judges the design as an editor of a
     technical publication would.
   - For prose: a codex fact-check of every changed sentence against the data,
     and a **cross-doc concision editor** that assigns an owner to every finding
     retold across docs and returns exact replacements with word savings.

   Deduplicate, classify each finding (blocks this PR / stacked follow-up),
   and fix the batch in one repair.

2. **What closes a finding** (the one definition; the merge gate reuses it).
   A defect is closed by a red test observed failing on the pre-repair code: a
   kit self-test, an SVG audit over every committed chart, a source-level
   assertion where no runtime test fits. Mutate the fix away and watch the test
   fail. A documentation, naming or style finding is closed by the corrected
   text, checked against its source. A claim the data refutes is closed by the
   evidence (a bot quoting a stale external limit gets the live page quoted
   back).
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

## 8. The merge gate

No PR merges until every finding is adjudicated and the bots have reviewed the
exact head:

- Request a `@codex` review and a `@coderabbitai` review on the head. A review
  of an earlier head covers nothing; re-request after every push. A green
  CodeRabbit status can mean "review skipped"; read its comment.
- Answer every finding with a reply that opens with `RED-VERIFIED: <test>`,
  `NOT-A-DEFECT: <reason>` or `DISAGREE: <evidence>`, as §6.2 defines what
  closes each. Resolve the thread after answering.
- If the repository has a merge-gate script or Makefile target, run it before
  calling a PR ready, and wait for the CI status that reports the same verdict
  where there is one. If it has none, check each item above by hand.
- Report the PR ready.

## Files

`<skill-dir>` is this skill's own directory, `~/.claude/skills/docs-design-pass`
in a default install. The scripts live in `<skill-dir>/scripts/`, apart from any
`scripts/` directory of the repository being worked on.

- `<skill-dir>/scripts/svg-audit.mjs`: legibility audit (text size, text and
  mark contrast, both themes). It certifies only an allowlisted subset (the
  elements, attributes, values and dark-mode stylesheet form a chart generator
  emits: rects, circles, lines, polylines, M/L/H/V/Z paths, plain text,
  `translate()`, no opacity) and reports anything else as an issue; text widths
  are bounded by Arial plus 10% and DejaVu Sans, measured per glyph. It is a
  lint for SVG your own generators emit, not a validator for untrusted input.
  `node <skill-dir>/scripts/svg-audit.mjs [--min-text 9] [--min-box-text 11] [--grid-color '#e4e8ec'] *.svg`,
  or import `auditSvg` into the repo's test. Exit 1 on any issue, 2 on a usage
  or read error; `-h` prints usage.
- `<skill-dir>/scripts/numcheck.mjs`: number-preservation check for prose
  edits, `node <skill-dir>/scripts/numcheck.mjs <base-ref> <doc.md>...`. Exit 1
  on an added number, 2 when the check could not run (bad ref, not a git
  repository).
- `<skill-dir>/scripts/linkcheck.mjs`: relative-link and anchor checker, GitHub
  slug rules, `node <skill-dir>/scripts/linkcheck.mjs <doc.md>...`. Exit 1 on a
  broken link, 2 on a usage or read error.
- `<skill-dir>/scripts/test-svg-audit.mjs`, `test-numcheck.mjs` and
  `test-linkcheck.mjs`: one `node:test` file per script, on fixtures in a temp
  directory (the numcheck and linkcheck tests build a throwaway git repository).
  Each file exits non-zero on any failure; one `node` call runs one file, so run
  them all with:

  ```sh
  for t in <skill-dir>/scripts/test-*.mjs; do node "$t" || exit 1; done
  ```

Other commands the sections above refer to:

- Rebase a stacked branch after its parent is rewritten:
  `git rebase --onto <new-parent> <old-parent> <branch>`.
- The codex reviewer, in the background with stdin closed (without
  `</dev/null` it can wait on stdin indefinitely):
  `codex exec -s read-only "<prompt>" </dev/null > log 2>&1`.
