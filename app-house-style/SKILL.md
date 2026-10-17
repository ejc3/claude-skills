---
name: app-house-style
description: A house style for building apps - a shareable TypeScript core under thin hosts (native SwiftUI on phones, web pages on wall screens, Astryx for interactive web pages) and Cloudflare Workers staged behind Access. Use this whenever starting an app or repository, adding a package, host or platform (web, iPhone, CLI, MCP), deciding where a piece of logic or wording belongs, choosing a UI library or CSS approach, or setting up CI or deploys - even when the request only says "build me an app for X" or "add a page".
---

# An app house style

**Where the specifics come from, in order:** `~/.claude/house-style.local.md`, then the
closest reference app it names, then this file. The local file holds what a public skill
cannot: the reference repositories, the runner labels, the infrastructure repository and who
applies it, and the tool that publishes a draft behind the access gate. If it is missing, say
so and ask for the reference app and the infrastructure repository; do not guess them.

When starting a repository, a package or a host, read the closest reference app's `AGENTS.md`
and `docs/ARCHITECTURE.md` first: consistency across the apps is worth more than a local
improvement. Inside an existing repository, its own docs are enough.

References, loaded when needed:
- `references/core-setup.md`: creating or changing a portable package (package.json,
  tsconfig, the purity lint, CI).
- `references/native-host.md`: anything under `apps/ios` or touching Hermes.
- `references/infra.md`: runners, deploy credentials, staging, secrets, sign-in.

## 1. The shape: a shared TypeScript core, thin hosts

```
engine/    the rules. TypeScript run directly by Node (type stripping, no build step).
           No platform, no I/O, no clock, no randomness: time, data and random bytes are arguments.
client/    the client library: stores, one way in (dispatch(action)), snapshots out, every word
           composed. The host passes a Platform object (storage, clock, network, keystore, ...).
<other>/   more portable packages when a domain earns one (keys/ for cryptography, say).
web/       a thin host: React views over client/ snapshots.
apps/ios/  a thin host: SwiftUI over client/ running in headless Hermes.
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
- **Lint enforces the core's purity** (references/core-setup.md), so a platform API in
  `src/` fails CI instead of surfacing on the one platform that lacks it.

**Which surface gets which host.** A personal device with OS services the app needs
(keychain, location, passkeys, notifications) gets a native host over the core: SwiftUI on
Apple's platforms. A surface whose browser someone else owns and fixes in place (TVs, e-ink
tablets, kiosks) gets a web page, because one page runs on all of them. When a native app
shows a whole wall screen (a preview), it embeds that page in a web view, as news readers
do; the app's own pages stay native.

## 2. The web host

- **Interactive pages** (app chrome, navigation, forms, settings, editors, dialogs, lists) are
  built on one component library, **Astryx** (`@astryxdesign/core`,
  github.com/facebook/astryx). It is in beta: pin the exact version of it and of its CLI,
  `@astryxdesign/cli` (a dev dependency), and upgrade both only with its codemods, in a PR of
  their own. The unscoped `astryx` package on npm is someone else's: install the CLI before
  any `npx astryx`, so it runs the project's copy. Follow its agent setup (`npx astryx init`
  puts its component index in `AGENTS.md`); its docs beat this file. One product theme per app;
  restyle with tokens or `className`. Leave its experimental package alone.
- **Surfaces with rules of their own** (wall screens, e-ink, canvases, games, print, email)
  keep a small stylesheet over the app's look tokens and never load the component library.
  Write their rules down and lint them in the page: a text floor set from viewing distance
  (a TV read from a sofa: about 22 px at 1080p), two values on e-ink, nothing that moves, no
  controls, no item cut in half (shed whole items; step type down no further than the floor).
- **Render on the client** (Vite + React) when the server must not see the data; otherwise
  follow the app's existing choice. Existing projects keep their UI stack unless asked to
  move.
- **Check visual work by screenshot** at each surface's real size, and look at the pictures.

## 3. Starting a repository

1. **New repo or downstream copy?** A new private repository in this style, unless the app
   needs another repository's code or data. Then make a downstream copy with an `upstream`
   remote, and keep it mergeable: its own code only in new top-level directories, a guard
   script that refuses edits to upstream paths, and upstream merged on a schedule.
2. **The design comes first.** The first PR is `docs/ARCHITECTURE.md` (and `AGENTS.md`, with
   `CLAUDE.md` a symlink to it): what it is for, the layout, the data and where it lives,
   invariants that will become tests, the stack of PRs, open questions. Mark the user's calls
   **DECIDED (date)**. Get an independent review of the design before code when it involves
   security, money, personal data or anything hard to change later.
3. **Stacked draft PRs**, each the smallest correct step, rebased when the one below changes.
4. **Personal data never in git.** Tests and previews use made-up sample data built around
   "now". Session values (profile names, model ids, ports, hostnames, account ids) stay out of
   files, commits and PR text.

## 4. Review and merging

- Every PR description carries exactly one line of each pair, checked in CI:
  ```
  Code-Review: ran          |  Code-Review: skipped — <reason>
  Simplify: ran             |  Simplify: skipped — <reason>
  ```
  Never write "ran" for a review that has not finished.
- Codex reviews substantive changes (`codex exec -s read-only` with a prompt naming the diff).
  **Where a defect would leak personal data or cannot be recalled once shipped**
  (cryptography, auth, sessions, location, what the server stores, payments), get two
  independent reviews every time: Codex and `/code-review` at high effort, whose different
  blind spots are the point. Run `/code-review` from inside the target repository or pass the
  PR URL; otherwise it reviews the session's working directory.
- Answer every thread as the repository's review gate says (the `pr-review-gate` skill where
  there is one), and post a review record comment listing each round's findings and fixes.
- In security code, every refusal has a test that watches it refuse.

## 5. Infrastructure (mechanics in references/infra.md)

- **Cloudflare Workers first;** D1, Durable Objects, R2 and KV are fine. The staging copy is
  `<app>-stage` behind Cloudflare Access, and **a URL never exists before its gate does**.
- **Secrets reach only reviewed, merged code:** deploy tokens live in a GitHub environment
  limited to `main`, and PRs never deploy.
- **CI runs on our own runners**, registered before the first workflow, as long as no
  drive-by non-contributor can make them run. A `pull_request` workflow file comes from the
  PR itself, so the gate is who may trigger a run: fork PR workflows need approval for all
  external contributors (Settings > Actions).
- **Infrastructure is code in its own repository, changed by PR** and applied by whoever the
  local file names. Secrets live in a secrets manager; never commit or print one.
- **Show the user a draft** by publishing it behind the access gate with the tool the local
  file names.
