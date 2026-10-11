---
name: vercel-to-cloudflare
description: Move a Next.js site from Vercel to Cloudflare Workers, or run it on both while it moves. A feature-by-feature map from Vercel to Cloudflare (OpenNext, wrangler.jsonc, env and secrets, previews, cron, storage, ISR caches, images, middleware and proxy, waitUntil and after, OIDC, client-IP headers, firewall and Access, logs, domains and TLS, size and runtime limits) with the gotchas that break a site only on Workers; a staged strategy from a protected staging Worker to a domain cutover with one-step rollback; pre- and post-cutover checklists; and how to run several site conversions at once without them colliding. Use when porting a Vercel site to Cloudflare, adding a Cloudflare deploy beside Vercel, planning or executing a domain cutover, or coordinating several such moves.
---

# Vercel to Cloudflare

A Next.js site runs on Cloudflare Workers through the OpenNext adapter
(`@opennextjs/cloudflare`). Most of a site moves unchanged. What breaks is
whatever leaned on Vercel's platform: its environment, its headers, its
storage products, its cron, its OIDC token, and its edge in front of the
domain. The work is finding those, giving each a Cloudflare equivalent, and
running both platforms until the Worker has earned the domain.

Cloudflare and OpenNext change monthly. When a limit or a default below
matters to a decision, check the linked page first; several pages contradict
each other (the size limit is an example) and the newest page wins.

## 1. The map

### Build and runtime

| Vercel | Cloudflare | Gotchas |
|---|---|---|
| Next.js built by Vercel | `@opennextjs/cloudflare` builds `.open-next/worker.js` and `.open-next/assets`; `npx @opennextjs/cloudflare migrate` scaffolds it | Scripts: `opennextjs-cloudflare build && opennextjs-cloudflare deploy` (or `upload` for a version without deploying, `preview` to run locally in workerd). The `build` script must still be `next build`. Add `.open-next` to `.gitignore`. Call `initOpenNextCloudflareForDev()` in `next.config.ts` so `next dev` sees bindings. Check the adapter's minimum Next.js version before bumping either: a new adapter release can require a newer Next.js patch, so pin them together. |
| `vercel.json` | `wrangler.jsonc` | Minimum: `name`, `main: ".open-next/worker.js"`, `compatibility_date`, `assets: { directory: ".open-next/assets", binding: "ASSETS" }`, and a `services` entry `WORKER_SELF_REFERENCE` pointing at the Worker's own name. Redirects, rewrites and headers stay in `next.config`; static `_headers` in `public/` cover assets. |
| Node.js runtime | workerd with `nodejs_compat` | Add `"compatibility_flags": ["nodejs_compat"]`. From compatibility date 2026-08-04 it is on by default, but keep it explicit while old dates exist. Native addons (`sharp`, binary query engines) do not run. Use drivers that speak HTTP or WebSocket, or Hyperdrive. |
| Edge runtime routes (`export const runtime = "edge"`) | Node.js runtime under OpenNext | OpenNext expects the Node.js runtime. Remove `runtime = "edge"` exports. |
| Function size (Vercel: 250 MB uncompressed) | Worker script size, plus a 1 s startup limit for global scope | The Workers limits page (Oct 2026) says 64 MiB uncompressed with no compressed limit. OpenNext's page and older docs still say 3 MiB (Free) / 10 MiB (Paid) compressed. Check which applies to your account. Startup is the limit you actually hit: keep heavy work out of module scope. `wrangler deploy --dry-run` prints `Total Upload` and `gzip`. |
| Function duration | CPU time: 10 ms on Free; on Paid 30 s by default and up to 5 min (`limits.cpu_ms`) | Waiting on I/O is not CPU time. A Free-plan Worker cannot run a real Next.js page. Plan on Workers Paid. |
| WebAssembly loaded from bytes at runtime | Import `.wasm` as a module | Workers cannot compile WebAssembly from bytes at runtime (`WebAssembly.compile`/`instantiate` on a buffer is blocked). Libraries that `fetch` or `readFile` their `.wasm` need a Workers or "edge" build, or a patch that imports it. |
| Filesystem (read-only bundle, writable `/tmp`) | No persistent writable filesystem. Files you did not import are not there | `fs.readFileSync(path.join(process.cwd(), "data/x.json"))` works on Vercel and fails on Workers. Import the file, inline it at build, or put it in `public/` and read it through the `ASSETS` binding. Write to KV, R2 or D1, never to disk. |
| `fetch(url, { redirect: "error" })` | Only `follow` and `manual` work | Workers throws `Invalid redirect value, must be one of follow or manual` before the request is sent. Node accepts `error`, so this bites only on Workers. Use `manual` and treat a 3xx as the error yourself. |
| `fetch` to the site's own public URL | `global_fetch_strictly_public` flag, or a service binding | Without the flag, a Worker's `fetch` to a hostname in its own zone goes to the zone's origin and skips Workers. With it, the request goes out through Cloudflare's front door like internet traffic (and can reach the same Worker again). For self-calls prefer `WORKER_SELF_REFERENCE`. |

### Configuration, secrets, previews

| Vercel | Cloudflare | Gotchas |
|---|---|---|
| Environment variables per target (Production / Preview / Development) | `vars` in `wrangler.jsonc` (plain, readable) and secrets (`wrangler secret put`, `wrangler secret bulk`; write-only) per Worker or per `env.<name>` | `NEXT_PUBLIC_*` and anything an SSG page reads are inlined **at build time**, so they must be in the CI job's environment when `opennextjs-cloudflare build` runs. A Worker secret is too late for them. Runtime values go in Worker secrets or vars. `wrangler deploy` replaces dashboard-set vars unless you pass `--keep-vars`; secrets survive deploys. |
| Reading a Vercel value back | Not possible for Cloudflare secrets either | Vercel never returns a `sensitive` variable after it is saved, and `vercel env pull` does not give you the real value. Take every secret from its original source (the provider console, your secret store), never from Vercel. Load the values into the Worker from stdin, after any deploy in flight has finished: a secret change made while a deploy uploads can be lost when that deploy activates. |
| `VERCEL_ENV`, `VERCEL_URL`, `VERCEL` | Nothing equivalent | Code that branches on these takes the wrong path on Workers. Add your own `APP_ENV` / `PUBLIC_ORIGIN` var to both platforms and switch on that. |
| Preview deployment per branch or PR | `wrangler versions upload --preview-alias <branch>` gives `<alias>-<worker>.<subdomain>.workers.dev`; or a separate staging Worker (`env.staging`) | Version (preview) URLs are public once enabled and are not available for Workers that define Durable Objects. OpenNext's DO queue and sharded tag cache are Durable Objects, so such a site gets previews from a separate Worker, not from Version URLs. Version URLs do not show up in Workers Logs or `wrangler tail`. |
| Deployment Protection | Cloudflare Access on `workers.dev` and Version URLs (Worker settings), or an Access application on a custom hostname | Create the Worker with `workers_dev: false` and `preview_urls: false`, put Access in front, then turn the URLs on. Wrangler re-applies both flags on **every** deploy, so the repo config and whatever else manages the Worker must agree. CI end-to-end tests get in with an Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers). |
| Git integration builds | Workers Builds, or your own CI running `opennextjs-cloudflare build` and `deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | Deploy only on `push` to `main` or a manual dispatch from `main`. Never deploy on `pull_request_target` or a fork's PR: the token can deploy any Worker it is scoped to. Guard dispatchable jobs with `if: github.ref == 'refs/heads/main'`. |
| Instant rollback | `wrangler rollback [<version-id>]`, or gradual deployments (`wrangler versions deploy` with percentages) | A rollback does not roll back secrets, bindings' data or D1 migrations. |

### Platform features

| Vercel | Cloudflare | Gotchas |
|---|---|---|
| Cron Jobs (`vercel.json` `crons`; a GET to the path on the production deployment, with `Authorization: Bearer $CRON_SECRET` when that variable is set) | Cron Triggers (`"triggers": { "crons": ["0 * * * *"] }`) calling a `scheduled` handler | OpenNext's generated worker only has `fetch`. Write a custom worker that re-exports it and adds `scheduled`, set `main` to that file, and re-export any DO classes the adapter uses (`DOQueueHandler`, `DOShardedTagCache`). Pattern below. Both schedules are UTC. Some jobs and self-pollers switch themselves on when `CRON_SECRET` is set or `VERCEL` is absent, so loading that secret into the Worker can start a second runner. Decide which platform owns each job before you load it. |
| `waitUntil` (`@vercel/functions`), `after()` | `after()` works under OpenNext; `getCloudflareContext().ctx.waitUntil()` | Replace `@vercel/functions` `waitUntil` with `after()`, which works on both platforms. |
| Middleware (`middleware.ts`, Edge) / `proxy.ts` (Next.js 16, Node.js) | Both supported by OpenNext | `proxy.ts` is always compiled for Node.js, and OpenNext's Node middleware path bundles a large part of the Next server: a no-op `proxy.ts` has added megabytes. Measure the bundle after the rename. |
| Vercel KV (now Upstash Redis via the Marketplace) | Workers KV, or keep Upstash over HTTP | KV is eventually consistent (writes can take up to a minute to show everywhere) with no atomic increment. Counters, locks and rate limits need a Durable Object, D1, or Redis. |
| Vercel Blob | R2 (binding, or the S3-compatible API) | Public blob URLs change host. Serve R2 through a custom domain or the Worker and rewrite stored URLs, or keep both until old URLs age out. |
| Vercel Postgres (now Neon via the Marketplace) / any Postgres | Hyperdrive in front of the same Postgres, or the provider's HTTP driver; D1 for SQLite | Keep the database where it is during the move. Both platforms then share one source of truth and nothing needs syncing. Moving data is a separate project. |
| Edge Config (now Global Config) | KV, or a `vars` entry for values that change rarely | KV reads are fast, but writes propagate slowly. |
| ISR, data cache, `revalidateTag` / `revalidatePath` | OpenNext caches in `open-next.config.ts` (`defineCloudflareConfig`): incremental cache (`r2IncrementalCache`, binding `NEXT_INC_CACHE_R2_BUCKET`, optionally `withRegionalCache`), queue (`doQueue`, binding `NEXT_CACHE_DO_QUEUE`), tag cache (`d1NextTagCache` / `NEXT_TAG_CACHE_D1`, or `doShardedTagCache` / `NEXT_TAG_CACHE_DO_SHARDED`) | With no cache configured, SSR still works but ISR pages rebuild on every request or serve only build-time HTML. Time-based revalidation needs a queue; on-demand revalidation needs a tag cache. KV as the incremental cache is not recommended (eventual consistency). The memory queue is for low-traffic staging only. Purging the Cloudflare cache on revalidation needs a zone (a custom domain) plus `CACHE_PURGE_API_TOKEN` and `CACHE_PURGE_ZONE_ID`. |
| Image Optimization (`next/image`) | Images binding (`"images": { "binding": "IMAGES" }`) or a custom loader using `/cdn-cgi/image/...` | Billed as Cloudflare Images. Through the binding, `minimumCacheTTL` and `dangerouslyAllowLocalIP` are not supported. A custom loader skips `remotePatterns` checks, so restrict source origins in the zone's Images settings. |
| OIDC federation to AWS/GCP (`VERCEL_OIDC_TOKEN`) | None: a Worker cannot present a Vercel OIDC token | Give the Worker its own narrowly scoped credential (for example an IAM user allowed only the calls it makes) as a Worker secret, with a rotation plan, or put a broker you run in between. Do not reuse a broad key because it was handy. |
| Client IP: `x-forwarded-for`, `x-real-ip`, `x-vercel-forwarded-for` (Vercel overwrites client-supplied XFF) | `CF-Connecting-IP` (set by Cloudflare); `X-Forwarded-For` may carry client-supplied hops | A per-IP rate limit or audit log keyed on `x-real-ip` or `x-vercel-forwarded-for` sees **nothing** on Workers. If it falls back to a constant, every visitor shares one bucket. Read the IP through one helper that prefers `cf-connecting-ip`, then the Vercel headers, and test it on both. Geo: `x-vercel-ip-country` → `request.cf.country` / `CF-IPCountry`. |
| Firewall, Attack Challenge Mode, Bot Protection | WAF custom rules, rate limiting rules, Bot Fight Mode, Turnstile, the Workers Rate Limiting binding | WAF and rate-limiting rules apply to a zone, so a Worker served only on `workers.dev` gets none of them. They start working at cutover. Port the rules before, not after. |
| Web Analytics / Speed Insights | Cloudflare Web Analytics; Workers Logs (`"observability": { "enabled": true }`), `wrangler tail`, Logpush | `@vercel/analytics` and Speed Insights load from `/_vercel/...`, which exists only on Vercel. Gate them on the platform or swap them out. To debug a Worker-only failure, run `wrangler tail --format pretty`, send real traffic, and log the error message, not just its name. |
| Domains and TLS on Vercel | Workers Custom Domain (`routes: [{ "pattern": "www.example.com", "custom_domain": true }]`) on a zone in Cloudflare | Cloudflare creates the DNS record and the certificate. A Custom Domain cannot be created on a hostname that still has a CNAME record, so cutting over means deleting the CNAME to Vercel first. **Never orange-cloud (proxy) a hostname Vercel still serves**: Vercel cannot see the real client or issue and renew its certificate, its firewall and bot protection go blind, and per-IP limits collapse onto Cloudflare's addresses. While Vercel serves a hostname, keep its record DNS-only (grey). To move, point the hostname at the Worker. |

### Cron handler pattern

```ts
// custom-worker.ts; set "main": "./custom-worker.ts" in wrangler.jsonc
// @ts-ignore: generated at build time
import { default as handler } from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    const req = new Request("https://<site-host>/api/cron/<job>", {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    ctx.waitUntil(handler.fetch(req, env, ctx));
  },
} satisfies ExportedHandler<CloudflareEnv>;

// Only if open-next.config.ts uses them:
// @ts-ignore
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
```

Calling `handler.fetch` in-process runs the existing route unchanged, with no
network hop and no self-fetch flag. Keep the route's bearer check so a
public request cannot trigger it. Map each `vercel.json` cron to one
`triggers.crons` entry. A `scheduled` handler gets one cron string per event
(`event.cron`), so switch on it when several jobs share the Worker.

## 2. Strategy

Run both platforms until the Worker has carried production for a while. Every
step below can be undone without touching the step before it.

| # | Step | Done when |
|---|---|---|
| 0 | **Inventory.** List everything Vercel-specific: `VERCEL_*` reads, `@vercel/*` packages, `vercel.json` crons/headers/redirects, every env var and which are build-time, storage products, OIDC use, client-IP reads, `fs` reads, `redirect: "error"`, `.wasm` loading, webhooks and OAuth clients that name the host. | Every row of section 1 that applies has an owner and a plan. |
| 1 | **Staging Worker, protected first.** `<site>-stage`, first deploy with `workers_dev: false` and `preview_urls: false`. Put Access on it, then enable the URLs. Non-production credentials only. | An anonymous request gets the Access login. A request with the service token gets the app. |
| 2 | **One source of truth for secrets.** Each secret lives in one store (a cloud secret manager, a password vault) and is pushed to both platforms by script or Terraform, per environment. Nobody edits a value in either dashboard. | Re-running the push is a no-op, and both platforms show the same variable names. |
| 3 | **CI for both.** The same PR runs both builds. Merging to `main` deploys Vercel (unchanged) and the staging Worker. `NEXT_PUBLIC_*` come from CI variables. | A red Workers build blocks a merge the way a red Vercel build does. |
| 4 | **Parity while both serve.** Every change must pass on both. Fix Worker-only breakage in the shared code (a helper for client IP, `APP_ENV` in place of `VERCEL_ENV`, `after()` in place of `waitUntil`), never with a platform fork that only one side exercises. | The staging Worker passes the same end-to-end suite as the Vercel preview. |
| 5 | **Production Worker.** `<site>` (or `env.production`) with production secrets, real caches (R2, a DO queue, a tag cache) and WAF / rate-limiting rules ready on the zone. Test it on `workers.dev` behind Access, or on a temporary hostname such as `next.example.com`. | Sign-in, payments, push, cron and webhooks all work against production data on the temporary host. |
| 6 | **Cutover.** Lower the hostname's TTL ahead of time (DNS-only records only; proxied records use Cloudflare's fixed TTL). In one window: delete the CNAME to Vercel, attach the Custom Domain, verify. Keep the domain assigned in the Vercel project. | Section 4 passes. |
| 7 | **Rollback, one step.** Remove the Custom Domain and recreate the DNS-only CNAME to Vercel. Write the exact record down before cutover. The Vercel project stays deployable and its env stays current, via the step 2 push. | Rehearsed once on the temporary hostname. |
| 8 | **Soak, then retire Vercel.** Leave Vercel deployable for at least a couple of weeks of real traffic and one full cron/billing cycle. Vercel's certificate for the hostname can stop renewing once DNS points away, so the rollback window is weeks, not months. Then remove the domain from Vercel, delete crons and webhooks there, revoke Vercel-only credentials (OIDC roles, tokens), and delete the project. | Nothing references the Vercel project. |

If the domain's DNS is not on Cloudflare yet, moving it there is its own
earlier step. Copy every record, keep the Vercel ones DNS-only, switch
nameservers, and wait until it is quiet. Do not combine that change with the
cutover.

## 3. Before cutover

- [ ] OAuth redirect URIs: the production host's callback (`/api/auth/callback/<provider>`) is still registered. Add the temporary host's callback for step 5, and remove it after.
- [ ] Auth library origin settings (`AUTH_URL`, `NEXTAUTH_URL`, `trustHost`, or the equivalent) are correct on the Worker.
- [ ] Push notifications: the same VAPID key pair on both. A new pair invalidates every existing subscription.
- [ ] Cron jobs: each one runs on exactly one platform. Disable it on Vercel in the same window it starts on Workers, never before.
- [ ] Webhooks (payments, Git, CMS, email) point at the hostname, not a `*.vercel.app` URL. Signing secrets are on the Worker.
- [ ] CORS and allowed-origin lists, CSP `connect-src`, and Server Action `allowedOrigins` include the Worker's temporary host while testing.
- [ ] Per-IP rate limits and audit logs read `CF-Connecting-IP` (via the shared helper), and that has been tested on the Worker.
- [ ] Cache headers: `_next/static` is immutable (`public/_headers`), HTML is not cached by mistake, and the ISR caches are configured, not defaulted.
- [ ] Error monitoring (Sentry or similar) is initialised for Workers and tagged by platform, so a spike can be traced to one side.
- [ ] WAF, rate-limiting and bot rules exist on the zone. Turnstile site keys allow the hostname.
- [ ] `vercel.json` redirects, rewrites and headers have been moved into `next.config` or `_headers`.
- [ ] Analytics: Vercel scripts gated off on the Worker, and the replacement installed.
- [ ] Rollback record written down. The Vercel deployment is current with `main`.

## 4. After cutover

- [ ] `curl -sI https://<host>/` shows Cloudflare (`server: cloudflare`, a `cf-ray` header) and no `x-vercel-id`, from more than one network.
- [ ] The certificate is valid for the hostname, and `www` and the apex both resolve to the intended target.
- [ ] Sign-in round trip with every provider. Sign-out. A session that started on Vercel still works or fails cleanly.
- [ ] An ISR page updates after its revalidate window, and an on-demand `revalidateTag`/`revalidatePath` takes effect.
- [ ] The next scheduled cron ran once (Workers Logs), and did not also run on Vercel.
- [ ] A webhook delivery from each provider succeeds (check the provider's delivery log).
- [ ] A rate-limited endpoint limits a single client, and does not limit everyone together.
- [ ] Images render and resize. No 4xx on `/_next/image` or `/cdn-cgi/image`.
- [ ] Workers Logs and error monitoring are flowing. CPU time and errors are watched for the first day.
- [ ] Vercel traffic for the hostname drops to zero within the TTL.

## 5. Keeping several running at once

Conversions of different sites are independent until they share something.
Parallelise the sites and serialise the shared things.

**Parallel**
- One site per agent and per branch, in its own clone or worktree. An agent
  never edits another site's repository.
- Independent staging Workers (`<site>-stage`), each with its own Access
  coverage, secrets and caches. Name every resource after the site.
- One shared deploy credential, scoped to **Workers scripts on one account
  only** (no DNS, no Access, no zone settings), stored once and copied into
  each repo's CI secrets by script. Rotate it in one place.
- Steps 0 to 5 for any number of sites.

**Serial**
- Domain cutovers (step 6). One production domain per window, with its
  post-cutover list complete before the next starts. Two at once make a
  failure ambiguous and double the rollback work.
- Moving a domain's DNS onto Cloudflare.
- Rotating a shared secret or the shared deploy credential: one rotation,
  then every consumer updated and verified, then the next.
- Anything on shared CI runners or minute budgets. Stagger heavy builds
  instead of starting every site's first OpenNext build at once.
- Changes to shared Access policies or zone-wide WAF rules.

**Tracker.** Keep one table where every agent can update its own row, and read it
before starting anything serial:

| Site | Step (0-8) | Staging Worker | Production Worker | Secrets pushed from source | CI both green | Cutover window | Rollback record | Owner | Blocker |
|---|---|---|---|---|---|---|---|---|---|
| `<site>` | 4 | `<site>-stage`, Access on | not yet | stage yes / prod no | yes | none yet | n/a | agent-1 | Worker-only `redirect: "error"` in API client |

A row moves forward only when its step's "done when" is true. The cutover
column is a lock: claim a window there before starting step 6, and clear it
after section 4 passes.

## References

- OpenNext for Cloudflare: https://opennext.js.org/cloudflare (get started, caching, custom worker, images, env vars)
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Compatibility flags: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Preview (Version) URLs: https://developers.cloudflare.com/workers/configuration/previews/
- Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Vercel request headers: https://vercel.com/docs/headers/request-headers
- Cloudflare in front of Vercel: https://vercel.com/kb/guide/cloudflare-with-vercel
