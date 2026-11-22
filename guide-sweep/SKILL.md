---
name: guide-sweep
description: "Checking that a plan is not missing anything by reading many how-to guides at once and deciding, opinionatedly, what to adopt. Parallel researchers each own one topic and read about ten real guides (not search snippets), each told what the plan already covers so they report gaps and disagreements with numbers and counts; the synthesis sorts every finding into change the product now, advice only, or left out on purpose, so the work stays tractable. Use when asked to find 'how-to guides', 'best practices', 'what am I missing' for a domain (a hobby build, an install, a setup), or to sanity-check an app's built-in rules against what practitioners do."
---

# Guide sweep

The question behind it is "are we missing anything?". The answer has to be a decision, not a
reading list: what changes now, what becomes advice, what is deliberately left out.

## 1. Split by topic, not by source

Pick four to six topics that cover the domain without overlap (for a holiday light show:
planning and buying; power and safety; mounting and install; controllers and networking; the
audience and music). One researcher per topic, about ten guides each, so fifty guides in all
arrive in parallel. A cheaper, fast model is fine for reading and extracting; keep the synthesis
for yourself.

## 2. The brief

Each researcher gets:

- **The topic and what counts:** substantive written guides from practitioners and vendors,
  each a different page, ideally different sites; a video only with a readable transcript.
- **What the plan already does, with its numbers** (for example "power injection every 100
  pixels; supplies loaded to 80% at 0.3 W a pixel"). Without this, researchers report what you
  already have.
- **The deliverable:** per guide, title, URL, site, date and concrete recommendations with their
  numbers; then a table of everything missing from the plan, with how many guides mention it and
  the strongest quote; then every place the guides disagree with the plan's numbers.
- **Honesty:** pages that would not load are named and left out, not filled from search
  snippets; summaries made by a fetch tool are labelled as such.
- One output file per researcher.

## 3. Synthesize opinionatedly

Read every report, then sort each finding into one of three:

1. **Change the product now:** it changes what is bought, how it is wired, or a number the app
   uses, and several guides agree. Each gets a test.
2. **Advice only:** worth saying in the product's own words (an install checklist, a setup
   sheet), but nothing to compute.
3. **Left out on purpose:** depends on things the product cannot see, is unsettled, or would make
   the work sprawl. Say why, so the next person does not re-raise it.

Also list **numbers that hold**: where the plan agrees with practitioners, so nobody tunes it
for no reason. A finding that is a genuine defect (a limit exceeded, a part that cannot work as
planned) is fixed with a test, not filed as advice.

## 4. Record it

Write a short section in the product's design doc: the three lists with their reasons, and the
sources read. Quote numbers as the guides gave them, and say the fetches were summarized when
they were.
