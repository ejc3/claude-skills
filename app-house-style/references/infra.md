# Infrastructure for a new app

Everything here is proposed as PRs to the infrastructure repository named in
`~/.claude/house-style.local.md`. Read its newest example of each piece before writing, and
mirror that example rather than these notes when they disagree.

## Self-hosted runners (before CI can run)

- Register the repository with the runner fleet behind a **token gate defaulting to off**: a
  variable such as `<repo>_token_ready = false` that the webhook and anything else needing
  the repository's token is conditioned on, so the first apply succeeds before the token
  exists.
- Give it a runner label and a concurrency cap like its neighbours.
- `terraform fmt` re-aligns neighbouring lines when a key is longer than its neighbours, and
  tests that pin those lines break: put new entries after a blank line (a separate alignment
  group) so existing lines do not move.
- Add a test pinning the new pieces next to the existing ones; when a neighbouring test fails,
  compare against `main` before blaming the change.
- After merge and apply, the owner mints a fine-grained token for that repository only
  (Administration read-write, Webhooks read-write, Actions read), stores it where the runners
  read it, and the gate is flipped to true in a commit of its own.

## Deploy credentials

- A shared Workers-only deploy token (Workers Scripts Write, Account Settings Read) when the
  app needs only Workers.
- Its own token when it also needs D1 (add D1 Write), minted by the infrastructure code,
  recorded in an administration-only secret, and put only into the repository's main-only
  GitHub environment.
- The deploy job runs on push to `main` (and by hand on `main`), never on PRs, and creates D1
  databases by name on first deploy.

## Staging behind Access

1. Merge the app's deploy workflow with `workers_dev` and `preview_urls` false in
   `wrangler.jsonc`; the first deploy creates `<app>-stage` with no public URL.
2. PR: add the Worker to the Access-protected staging list with its URLs off; apply adopts it
   into the Access application.
3. PR: turn its URLs on, and in the app repository `workers_dev`/`preview_urls` true,
   together. Never reverse 2 and 3: a URL that exists before Access covers it is public.

## Secrets and sign-in

- App secrets live in the secrets manager and are loaded into a Worker by the infrastructure
  repository's tooling, never pasted by hand.
- Sign-in: the owner creates the Google OAuth client and the Sign in with Apple service id.
  The code side uses `oauth4webapi`, `__Host-` cookies, PKCE and a nonce, and keeps the app's
  session in the Keychain on Apple's platforms.
