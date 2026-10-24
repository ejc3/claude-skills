# claude-skills

Skills for [Claude Code](https://docs.claude.com/en/docs/claude-code). Each
directory is one skill: a `SKILL.md` with its instructions, and any scripts or
templates it uses.

| Skill | What it is for |
|---|---|
| [`pr-diligence`](pr-diligence/SKILL.md) | Preparing a pull request someone else will judge, such as a fix sent upstream: a red/green regression test in the builds the project's CI uses, a fix no bigger than the defect, parallel independent review of a frozen packet, a private-value scan, plain PR text, and a public walkthrough page of the code generated from git. For leak and use-after-free fixes, an ownership table and a review that lists every producer. Also landing a stack of PRs through its top with GitHub's stacked PRs. |
| [`cloudflare`](cloudflare/SKILL.md) | Building, moving and running a site on Cloudflare Workers. Moving a Next.js site from Vercel, or running it on both during the move: a Vercel-to-Cloudflare feature map with the gotchas that break only on Workers, a staged strategy from a protected staging Worker to a domain cutover with one-step rollback, pre- and post-cutover checklists, how to run several conversions at once, and lessons from a move made under a deadline. Running on Workers: never sharing I/O or promises across requests, a timeout on every outbound call (Turso/libSQL as the worked case), pages that never wait for ever, reading Workers Logs, and shipping a fix during an outage. |
| [`upstash-to-valkey`](upstash-to-valkey/SKILL.md) | Moving a Redis off Upstash (a Vercel Marketplace store included) to self-hosted Valkey without changing application code, or deciding not to: options with prices, measured latency and failover benchmarks, the serverless-redis-http front and its two fixes, an ECS task design tuned from a 108 s to a 74 s failover, a backup-restore-reconcile procedure that fences the old store so late writes are not lost, and a failover test. |
| [`docs-design-pass`](docs-design-pass/SKILL.md) | Raising a repository's charts, figures and prose to the standard of a well-made technical paper without changing a measured value: design counsel first, a shared style kit, stacked PRs, a phone-readable text alternative for every rasterized chart, prose cut to one statement per finding, parallel independent review with red tests for every accepted defect, and a merge gate on bot reviews and adjudicated findings. |
| [`apple-hig-review`](apple-hig-review/SKILL.md) | Comparing an Apple-platform app with the current Human Interface Guidelines (iOS, iPadOS, macOS and the rest), or a web app as it runs in mobile Safari and Chrome against WCAG 2.2 and each platform's conventions: real screenshots first, findings resting on authoritative sources, parallel reviewers that each own one area and research the current guidelines, cited file:line findings ranked by severity with verified facts kept apart from judgment, one consolidated report, and stacked fixes checked on a device. |
| [`mobile-safari`](mobile-safari/SKILL.md) | Building a website people use on phones, iPhone Safari above all: AutoFill (autocomplete tokens and sections, `insertReplacementText` versus spelling corrections, lookups that race or land late), input zoom, sideways scroll, `dvh` and safe areas, touch and hover, home-screen installs and their separate storage, location and stale first fixes, the screen wake lock across sleep, background tabs, slow phones, and how to test each with Playwright's WebKit and the iOS Simulator. |
| [`app-house-style`](app-house-style/SKILL.md) | Building an app in one consistent house style: a shareable TypeScript core (engine and client, with no platform, clock or randomness in them, enforced by lint) under thin hosts, native SwiftUI over the core in headless Hermes on phones, web pages for wall and kiosk screens, Astryx for interactive web pages, every visible word composed in the core, a design doc and stacked draft PRs, two independent reviews for security work, and Cloudflare Workers with an Access-gated staging copy. Owner-specific names go in a local file the skill reads first. |
| [`drive-mac`](drive-mac/SKILL.md) | Using the owner's Mac from a remote agent session: builds, AppleScript and Chrome, Peekaboo, signing through the GUI session, sharing the Mac with other sessions (a desktop lease and a build cap), and when to approve a macOS permission prompt. Also setting up another Mac, or a Windows PC over a reverse SSH tunnel, the same way. How to reach the Mac is in a local file the skill reads first. |
| [`sports-data-provider`](sports-data-provider/SKILL.md) | Building a provider-agnostic sports-data ingest layer and settling on one concrete provider (Ball Don't Lie as the worked example): providers chosen as data behind one interface, a generated installed-list and a registry that selects by configuration so private adapters stay out of a public build, per-league config as data, and the normalisation that must sit in front of a deterministic engine — season-year conventions, UTC-vs-local day boundaries, unstarted games by status rather than score, id stability, and reading the rate-limit headers rather than trusting the tier. Owner-specific names go in a local file the skill reads first. |

## Install

Clone the repository and link the skills you want into `~/.claude/skills`:

```sh
git clone https://github.com/ejc3/claude-skills ~/claude-skills
ln -s ~/claude-skills/pr-diligence ~/.claude/skills/pr-diligence
ln -s ~/claude-skills/cloudflare ~/.claude/skills/cloudflare
ln -s ~/claude-skills/docs-design-pass ~/.claude/skills/docs-design-pass
ln -s ~/claude-skills/apple-hig-review ~/.claude/skills/apple-hig-review
ln -s ~/claude-skills/mobile-safari ~/.claude/skills/mobile-safari
ln -s ~/claude-skills/upstash-to-valkey ~/.claude/skills/upstash-to-valkey
ln -s ~/claude-skills/app-house-style ~/.claude/skills/app-house-style
ln -s ~/claude-skills/drive-mac ~/.claude/skills/drive-mac
ln -s ~/claude-skills/sports-data-provider ~/.claude/skills/sports-data-provider
```

Claude Code picks up skills in `~/.claude/skills` at the start of a session.

## Contributing

Changes land by pull request. Each PR description must carry one
`Code-Review:` and one `Simplify:` decision line (`ran`, or `skipped — <reason>`);
the `review decision` check fails without them. Review threads are answered as
the `pr-review-gate` skill in `.claude/skills/` describes. See
[`AGENTS.md`](AGENTS.md).

## pr-diligence: an example

[tmux/tmux#5722](https://github.com/tmux/tmux/pull/5722) fixes a server crash:
a menu stays open after the pane it was opened for is gone, and the next
redraw reads the freed pane. It was prepared with this skill:

- **The pull request**: two commits, a 29-line regression test and then a
  10-line fix that reuses a check tmux already applies elsewhere. The text
  leads with what goes wrong, gives a one-line reproducer, and states what was
  tested and what was not.
- **The walkthrough**:
  [a public page](https://claude.ai/artifact/EQfdpWANP4vkDLXb5fTMHJ), linked
  from the pull request. It covers the crash with its sanitizer report, the code
  path to the freed pointer, the diff with numbered notes, why the new check
  is safe on freed pointers, the test explained by line number, the evidence,
  and the pull request text.
- **Behind it**: the test was run five times each against master and the fix,
  in plain and AddressSanitizer builds, plus the full regress suite. Five
  reviewers worked in parallel on a frozen packet, then two closure passes
  checked the repairs. A private-value scan ran before the push.

The same batch also produced
[#5723](https://github.com/tmux/tmux/pull/5723),
[#5724](https://github.com/tmux/tmux/pull/5724) and
[#5725](https://github.com/tmux/tmux/pull/5725), each with its own
walkthrough linked from the pull request.

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
