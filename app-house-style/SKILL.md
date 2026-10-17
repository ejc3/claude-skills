---
name: app-house-style
description: A house style for building apps - a shareable TypeScript core (engine and client, no platform in them) with native UIs on top (SwiftUI over the core in headless Hermes), web pages for wall and kiosk screens, Astryx for interactive web pages, and a review-heavy process (design doc first, stacked draft PRs, two independent reviews for security work, Cloudflare Workers with an Access-gated staging copy, self-hosted CI runners, infrastructure proposed as PRs). Use this whenever starting a new app or repository, adding a package, host or platform (web, iPhone, CLI, MCP) to an existing one, deciding where a piece of logic or wording belongs, picking a UI library or CSS approach, or setting up CI or deploys - even when the request only says "build me an app for X" or "add a page".
---

# An app house style

**First, read `~/.claude/house-style.local.md` if it exists.** It names what a public skill
cannot: this owner's reference repositories (copy their structure before inventing any), the
runner labels, the infrastructure repository and its rules, and the tool that publishes a
draft behind the access gate. Where it and this file disagree, it wins.

Consistency across the owner's apps is worth more than a local improvement: read the closest
reference app's `AGENTS.md` and `docs/ARCHITECTURE.md` before choosing a structure.

## 1. The shape: a shared TypeScript core, native UIs

```
engine/    the rules. TypeScript run directly by Node 22 (type stripping, no build step).
           No platform, no I/O, no clock, no randomness: time, data and random bytes are arguments.
client/    the client library: stores, one way in (dispatch(action)), snapshots out, every word
           composed. The host passes a Platform object (storage, clock, network, keystore, ...).
<other>/   more portable packages when a domain earns one (keys/ for cryptography, say).
web/       a thin host: React views over client/ snapshots.
apps/ios/  a thin host: SwiftUI over client/ running in headless Hermes (references/native-host.md).
cli/       a host for scripts and agents; often also the local MCP server.
server/    when there is one: stores and routes; it does not compute the product's answers.
pipeline/  offline loops that write committed data (scrapers, fits).
```

**Why:** the same rules must give the same answer on the web, on the phone and in an agent.
If a view computes anything, the native app has to repeat it, and the two drift. So:

- **A UI may** draw a snapshot or view model, measure what it drew (fit, legibility), and
  send an action.
- **A UI may not** compute a time, filter or sort a list, choose a word, decide what is
  private or stale, or format a number. Every visible string comes from the core. If you
  find English in a React component or a SwiftUI view, move it into a view model.
- **Lint enforces the core's purity** (references/core-setup.md): no `node:*` imports, no
  `Date.now`, no `Math.random`, no `fetch`/`window`/`process`/`crypto` globals in `src/`.

**Which UI is native.** Phones (and later tablets and Macs) get native apps: SwiftUI on
Apple's platforms. **Wall and kiosk screens (TVs, e-ink tablets) are web pages** in the
screen's own browser; there are no TV-box or Android apps for them. When a native app needs
to show a whole wall screen (a preview), it embeds the page in a web view, as news readers
do; the app's own pages stay native.

## 2. The web host

- **Interactive pages** (app chrome, navigation, forms, settings, editors, dialogs, lists) are
  built on **Astryx** (`@astryxdesign/core`, github.com/facebook/astryx). Pin the exact
  version (it is in beta) and upgrade only with its codemods in a PR of their own. Run
  `npx astryx init` so its component index is in the project's `AGENTS.md`/`CLAUDE.md`; look
  components up with `astryx component <Name>` and start pages from `astryx template`. One
  product theme per app; restyle with tokens or `className`. Not `@astryxdesign/lab`.
- **Rendering surfaces with rules of their own** (wall screens, e-ink, canvases, games, print,
  email) keep a small stylesheet of their own over the app's look tokens, and their pages
  never load Astryx. Typical rules there: a text floor (a TV read from a sofa: nothing under
  22 px at 1080p), two values on e-ink, nothing that moves, no controls, an item is never cut
  in half (shed whole items, step type down no further than the floor).
- **Client-rendered** (Vite + React) when the page must decrypt or compute on the device;
  otherwise follow the app's existing choice. Existing projects keep their UI stack unless
  the owner asks to move them.
- **Check visual work by screenshot** at the surfaces' real sizes and look at the pictures;
  build a linter for the surface's rules and run it in the page.

## 3. Starting a repository

1. **New repo or downstream copy?** A new private repository in this style unless the app
   needs another repository's code or data. Then make a *downstream copy* with an `upstream`
   remote (a plain fork when the organisation allows forks). A downstream copy never edits
   upstream-owned paths (a guard script enforces it), keeps its own code in new top-level
   directories, and merges upstream on a schedule with a merge commit.
2. **The design comes first.** The first PR is `docs/ARCHITECTURE.md` (and `AGENTS.md`, with
   `CLAUDE.md` a symlink to it): what it is for, the layout, the data and where it lives,
   invariants that will become tests, the stack of PRs, open questions. Mark the owner's calls
   **DECIDED (date)**. Get an independent review of the design before code when it involves
   security, money, personal data or anything hard to change later.
3. **Stacked draft PRs**, each the smallest correct step, rebased when the one below changes.
4. **Personal data never in git.** Tests and previews use made-up sample data built around
   "now". Keep session values (profile names, model ids, ports, hostnames, account ids) out of
   files, commits and PR text.

## 4. Review and merging

- Every PR description carries one line of each pair, and a `review decision` check fails
  without exactly one of each:
  ```
  Code-Review: ran          |  Code-Review: skipped — <reason>
  Simplify: ran             |  Simplify: skipped — <reason>
  ```
  Never write "ran" for a review that has not finished.
- Codex reviews substantive changes (`codex exec -s read-only` with a prompt naming the diff,
  or `codex review --base <branch>`). **Cryptography, auth, sessions, location and anything
  about what the server stores get two independent reviews every time: Codex and
  `/code-review` at high effort.** Run `/code-review` from inside the target repository (or pass
  the PR URL): otherwise it reviews the session's working directory.
- Fix every real finding; answer the rest on the PR. Post a review record comment listing each
  round's findings and fixes. Chase correctness and safety, not nits.
- Prototype discipline: test what would mislead a user or expose data, one focused test per
  real bug; in security code, every refusal has a test that watches it refuse.

## 5. Infrastructure (details in references/infra.md)

- **Cloudflare Workers first.** The staging copy is `<app>-stage` behind Cloudflare Access,
  adopted into the Access application after its first deploy with its URLs off. D1, Durable
  Objects, R2 and KV are fine to use. Deploy tokens live only in a GitHub environment limited
  to `main`; deploy jobs run on push to `main`, never on PRs.
- **CI on self-hosted runners**, never GitHub-hosted: a new repository is registered with the
  runners (behind a token gate) before its first workflow.
- **Infrastructure is code in its own repository, changed by PR.** Accounts, tokens, runners
  and Access are proposed there, and applied by whoever the local file says applies them.
- **Secrets** live in a secrets manager and reach a Worker or CI through the infrastructure
  repository; production values only to production. Never commit or print one.

## 6. Checklist for a new app or a new host

- [ ] Read the closest reference app's AGENTS.md and ARCHITECTURE.md.
- [ ] Design PR first; DECIDED marks for the owner's calls.
- [ ] Portable packages with the purity lint; tests run with `node --test` on `.ts` directly.
- [ ] Every word on screen composed in the core; hosts draw only.
- [ ] Native UI for phone apps (SwiftUI over Hermes); web for wall screens; Astryx for
      interactive web pages, pinned.
- [ ] Sample data, never real data, in tests and previews.
- [ ] CI on self-hosted runners and the review-decision check; registration proposed first.
- [ ] Staging Worker behind Access; deploy token in a main-only environment.
- [ ] Two reviews for anything security- or privacy-sensitive.
