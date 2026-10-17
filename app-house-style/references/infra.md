# Infrastructure for a new app

Proposed as PRs to the infrastructure repository named in `~/.claude/house-style.local.md`.
This file gives the orderings and their reasons; names, scopes and syntax come from that
repository's newest example of each piece.

## Self-hosted runners (before CI can run)

- Register the repository behind a **token gate defaulting to off**: a variable such as
  `<repo>_token_ready = false` that everything needing the repository's token depends on, so
  the first apply succeeds before the token exists.
- Give it a runner label and a concurrency cap like its neighbours.
- Tests that pin formatted lines break when `terraform fmt` re-aligns a group: put new entries
  in a group of their own (after a blank line) so existing lines do not move.
- After apply, the user mints a token for that one repository, with the least scope the
  runners need, stores it where the runners read it, and the gate is flipped in its own commit.

## Deploy credentials

- A least-privilege Workers deploy token per app (or the shared one, if the app needs only
  Workers), minted by the infrastructure code, recorded in an administration-only secret, and
  put only into the repository's main-only GitHub environment.
- The deploy job runs on push to `main` (and by hand on `main`), never on PRs, and creates D1
  databases by name on first deploy.

## Staging behind Access

The flags, their reason and how CI gets through Access are in the `vercel-to-cloudflare`
skill ("Staging Worker, protected first"). The order across repositories:

1. Merge the app's deploy workflow with `workers_dev` and `preview_urls` false; the first
   deploy creates `<app>-stage` with no public URL.
2. Infrastructure PR: put the Worker under the Access application with its URLs off.
3. Infrastructure PR: Access covers the Worker's `workers.dev` and preview hostnames; wait
   until it is applied.
4. Only then the app PR that sets `workers_dev` and `preview_urls` true. Two repositories
   cannot land at the same moment, and if the app deploys first its URLs are public until
   the apply.

## Sign-in

The user creates the Google OAuth client and the Sign in with Apple service id. The code side
uses `oauth4webapi`, `__Host-` cookies, PKCE and a nonce, and keeps the app's session in the
Keychain on Apple's platforms.
