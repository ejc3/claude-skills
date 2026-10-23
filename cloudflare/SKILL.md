---
name: cloudflare
description: "Build, move and run a site on Cloudflare Workers. Moving a Next.js site from Vercel to Cloudflare Workers, or running it on both while it moves. A feature-by-feature map from Vercel to Cloudflare (OpenNext, wrangler.jsonc, env and secrets, previews, cron, storage, ISR caches, images, middleware and proxy, waitUntil and after, OIDC, client-IP headers, firewall and Access, logs, domains and TLS, size and runtime limits) with the gotchas that break a site only on Workers; a staged strategy from a protected staging Worker to a domain cutover with one-step rollback; pre- and post-cutover checklists; how to run several site conversions at once without them colliding; and lessons from a move made under a deadline (data keyed by VERCEL_ENV, per-environment builds, migrations, cron time limits, Marketplace storage). Running on Workers: the traps that break a Worker only in production, with Turso/libSQL as the worked case (I/O or promises shared across requests hang every later request in an isolate, outbound calls need a timeout, pages must not wait for ever, reading Workers Logs to tell a hang from an error, shipping a fix during an outage past branch rules and a busy CI pool) in workers-gotchas.md. Use when writing or reviewing Worker code that talks to a database or another API, when a Worker request hangs or is canceled, when diagnosing an outage from Workers Logs, when porting a Vercel site to Cloudflare, adding a Cloudflare deploy beside Vercel, planning or executing a domain cutover, or coordinating several such moves."
---

# Cloudflare

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
| Function bundle size (Vercel allows far larger bundles) | Worker script size, plus a 1 s startup limit for global scope | The Workers limits page (Oct 2026): 64 MiB uncompressed, no compressed limit. Older pages, OpenNext's included, still say 3 MiB / 10 MiB compressed; the limits page is current. Startup is the limit you actually hit: keep heavy work out of module scope. `wrangler deploy --dry-run` prints `Total Upload` and `gzip`. |
| Function duration | CPU time: 10 ms on Free; on Paid 30 s by default and up to 5 min (`limits.cpu_ms`) | Waiting on I/O is not CPU time. A Free-plan Worker cannot run a real Next.js page. Plan on Workers Paid. |
| WebAssembly loaded from bytes at runtime | Import `.wasm` as a module | Workers cannot compile WebAssembly from bytes at runtime (`WebAssembly.compile`/`instantiate` on a buffer is blocked). Libraries that `fetch` or `readFile` their `.wasm` need a Workers or "edge" build, or a patch that imports it. |
| Filesystem (read-only bundle, writable `/tmp`) | No persistent writable filesystem. Files you did not import are not there | `fs.readFileSync(path.join(process.cwd(), "data/x.json"))` works on Vercel and fails on Workers. Import the file, inline it at build, or put it in `public/` and read it through the `ASSETS` binding. Write to KV, R2 or D1, never to disk. |
| `fetch(url, { redirect: "error" })` | Only `follow` and `manual` work | Workers throws `Invalid redirect value, must be one of follow or manual` before the request is sent. Node accepts `error`, so this bites only on Workers. Use `manual` and treat a 3xx as the error yourself. |
| `fetch` to the site's own public URL | A service binding (`WORKER_SELF_REFERENCE`), or the `global_fetch_strictly_public` flag | Without the flag, a same-zone `fetch` to a hostname served by a Worker *route* goes to the zone's origin and skips the Worker; a Worker on a *Custom Domain* is invoked. With the flag, every `fetch` goes out through Cloudflare's front door like internet traffic, so it can reach the same Worker again. Behaviour therefore changes between `workers.dev`, a route and a Custom Domain. For self-calls use the service binding, which behaves the same everywhere. |

### Configuration, secrets, previews

| Vercel | Cloudflare | Gotchas |
|---|---|---|
| Environment variables per target (Production / Preview / Development) | `vars` in `wrangler.jsonc` (plain, readable) and secrets (`wrangler secret put`, `wrangler secret bulk`; write-only) per Worker or per `env.<name>` | `NEXT_PUBLIC_*` and anything an SSG page reads are inlined **at build time**, so they must be in the CI job's environment when `opennextjs-cloudflare build` runs. A Worker secret is too late for them. Runtime values go in Worker secrets or vars. `wrangler deploy` replaces dashboard-set vars unless you pass `--keep-vars`; secrets survive deploys. |
| Reading a Vercel value back | Not possible for Cloudflare secrets either | Vercel never returns a `sensitive` variable after it is saved, and `vercel env pull` does not give you the real value. Take every secret from its original source (the provider console, your secret store), never from Vercel. Load the values into the Worker from stdin, after any deploy in flight has finished: a secret change made while a deploy uploads can be lost when that deploy activates. |
| `VERCEL_ENV`, `VERCEL_URL`, `VERCEL` | Nothing equivalent | Code that branches on these takes the wrong path on Workers. Add your own `APP_ENV` / `PUBLIC_ORIGIN` var to both platforms and switch on that. |
| Preview deployment per branch or PR | `wrangler versions upload --preview-alias <branch>` gives `<alias>-<worker>.<subdomain>.workers.dev`; or a separate staging Worker (`env.staging`) | Version (preview) URLs are public once enabled and are not available for Workers that define Durable Objects. OpenNext's DO queue and sharded tag cache are Durable Objects, so such a site gets previews from a separate Worker, not from Version URLs. Version URLs do not show up in Workers Logs or `wrangler tail`. |
| Deployment Protection | Cloudflare Access on `workers.dev` and Version URLs (Worker settings), or an Access application on a custom hostname | Create the Worker with `workers_dev: false` and `preview_urls: false`, put Access in front, then turn the URLs on. Wrangler re-applies both flags on **every** deploy, so the repo config and whatever else manages the Worker must agree. CI end-to-end tests get in with an Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers). |
| Git integration builds | Workers Builds, or your own CI running `opennextjs-cloudflare build` and `deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | Deploy only on `push` to `main` or a manual dispatch from `main`. Never deploy on `pull_request_target` or a fork's PR: the token can deploy any Worker it is scoped to. Guard dispatchable jobs with `if: github.ref == 'refs/heads/main'`. |
| Instant rollback | `wrangler rollback [<version-id>]`, or gradual deployments (`wrangler versions deploy` with percentages) | Connected resources are not rolled back: KV, R2 and D1 data and D1 migrations stay as they are, and a Durable Object class change between the versions blocks the rollback. The docs do not say what happens to secrets changed since that version, so push secrets again from the source after any rollback. |

### Platform features

| Vercel | Cloudflare | Gotchas |
|---|---|---|
| Cron Jobs (`vercel.json` `crons`; a GET to the path on the production deployment, with `Authorization: Bearer $CRON_SECRET` when that variable is set) | Cron Triggers (`"triggers": { "crons": ["0 * * * *"] }`) calling a `scheduled` handler | OpenNext's generated worker only has `fetch`. Write a custom worker that re-exports it and adds `scheduled`, set `main` to that file, and re-export any DO classes the adapter uses (`DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge`). Pattern below. Both schedules are UTC. Cron CPU time: 10 ms on Free; on Paid 30 s for intervals under an hour and 15 min for hourly or longer. A long Vercel job moved to a frequent trigger can be cut off. Some jobs and self-pollers switch themselves on when `CRON_SECRET` is set or `VERCEL` is absent, so loading that secret into the Worker can start a second runner. Decide which platform owns each job before you load it. |
| `waitUntil` (`@vercel/functions`), `after()` | `after()` works under OpenNext; `getCloudflareContext().ctx.waitUntil()` | Replace `@vercel/functions` `waitUntil` with `after()`, which works on both platforms. |
| Middleware (`middleware.ts`, Edge) / `proxy.ts` (Next.js 16, Node.js) | Both supported by OpenNext | `proxy.ts` is always compiled for Node.js, and OpenNext's Node middleware path bundles a large part of the Next server: a no-op `proxy.ts` has added megabytes. Measure the bundle after the rename. |
| Vercel KV (now Upstash Redis via the Marketplace) | Workers KV, or keep Upstash over HTTP | KV is eventually consistent (writes can take up to a minute to show everywhere) with no atomic increment. Counters, locks and rate limits need a Durable Object, D1, or Redis. |
| Vercel Blob | R2 (binding, or the S3-compatible API) | Public blob URLs change host. Serve R2 through a custom domain or the Worker and rewrite stored URLs, or keep both until old URLs age out. |
| Vercel Postgres (now Neon via the Marketplace) / any Postgres | Hyperdrive in front of the same Postgres, or the provider's HTTP driver; D1 for SQLite | Keep the database where it is during the move. Both platforms then share one source of truth and nothing needs syncing. Moving data is a separate project. |
| Edge Config (now Global Config) | KV, or a `vars` entry for values that change rarely | KV reads are fast, but writes propagate slowly. |
| ISR, data cache, `revalidateTag` / `revalidatePath` | OpenNext caches in `open-next.config.ts` (`defineCloudflareConfig`): incremental cache (`r2IncrementalCache`, binding `NEXT_INC_CACHE_R2_BUCKET`, optionally `withRegionalCache`), queue (`doQueue`, binding `NEXT_CACHE_DO_QUEUE`), tag cache (`d1NextTagCache` / `NEXT_TAG_CACHE_D1`, or `doShardedTagCache` / `NEXT_TAG_CACHE_DO_SHARDED`) | With no cache configured, SSR still works but ISR pages rebuild on every request or serve only build-time HTML. Time-based revalidation needs a queue; on-demand revalidation needs a tag cache. KV as the incremental cache is not recommended (eventual consistency). The memory queue is for low-traffic staging only. Purging the Cloudflare cache on revalidation needs a zone (a custom domain) plus `CACHE_PURGE_API_TOKEN` and `CACHE_PURGE_ZONE_ID`. |
| Image Optimization (`next/image`) | Images binding (`"images": { "binding": "IMAGES" }`) or a custom loader using `/cdn-cgi/image/...` | Billed as Cloudflare Images. Through the binding, `minimumCacheTTL` and `dangerouslyAllowLocalIP` are not supported. A custom loader skips `remotePatterns` checks, so restrict source origins in the zone's Images settings. |
| OIDC federation to AWS/GCP (`VERCEL_OIDC_TOKEN`) | None: a Worker cannot present a Vercel OIDC token | Give the Worker its own narrowly scoped credential (for example an IAM user allowed only the calls it makes) as a Worker secret, with a rotation plan, or put a broker you run in between. Do not reuse a broad key because it was handy. |
| Client IP: `x-forwarded-for`, `x-real-ip`, `x-vercel-forwarded-for` (Vercel overwrites client-supplied XFF) | `CF-Connecting-IP` (set by Cloudflare); `X-Forwarded-For` may carry client-supplied hops | A per-IP rate limit or audit log keyed on `x-real-ip` or `x-vercel-forwarded-for` sees **nothing** on Workers. If it falls back to a constant, every visitor shares one bucket. Read the IP through one helper that chooses the header **by platform**: `cf-connecting-ip` only on Workers, the Vercel headers only on Vercel. Do not try them in a fixed order, because Vercel passes a client-supplied `CF-Connecting-IP` through untouched, so anyone could pick their own IP. Test it on both. Geo: `x-vercel-ip-country` → `request.cf.country` / `CF-IPCountry`. |
| Firewall, Attack Challenge Mode, Bot Protection | WAF custom rules, rate limiting rules, Bot Fight Mode, Turnstile, the Workers Rate Limiting binding | WAF and rate-limiting rules apply to a zone, so a Worker served only on `workers.dev` gets none of them. They start working at cutover. Port the rules before, not after. |
| Web Analytics / Speed Insights | Cloudflare Web Analytics; Workers Logs (`"observability": { "enabled": true }`), `wrangler tail`, Logpush | `@vercel/analytics` and Speed Insights load from `/_vercel/...`, which exists only on Vercel. Gate them on the platform or swap them out. To debug a Worker-only failure, run `wrangler tail --format pretty`, send real traffic, and log the error message, not just its name. |
| Domains and TLS on Vercel | A Worker route (`routes: [{ "pattern": "www.example.com/*", "zone_name": "example.com" }]`) on the existing record, switched to proxied at cutover (step 6); or a Workers Custom Domain (`{ "pattern": "www.example.com", "custom_domain": true }`) on a zone in Cloudflare | A route needs a proxied record and runs the Worker in front of that record's origin. For a Custom Domain, Cloudflare creates the DNS record and the certificate. A Custom Domain cannot be created on a hostname that still has a CNAME record. **Never orange-cloud (proxy) a hostname Vercel still serves**: Vercel cannot see the real client or issue and renew its certificate, its firewall and bot protection go blind, and per-IP limits collapse onto Cloudflare's addresses. While Vercel serves a hostname, keep its record DNS-only (grey). Move the hostname with the step 6 procedure, never by editing the CNAME's target. |

### Cron handler pattern

```ts
// custom-worker.ts; set "main": "./custom-worker.ts" in wrangler.jsonc
// @ts-ignore: generated at build time
import { default as handler } from "./.open-next/worker.js";

// The route's maxDuration. Vercel killed the function there; a Worker does not.
const DEADLINE_MS = 60_000;

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    const req = new Request("https://<site-host>/api/cron/<job>", {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    // Work the pass registers with waitUntil (after(), cache writes) is
    // collected and awaited inside the deadline rather than handed to the
    // runtime: when this handler settles the invocation ends and the runtime
    // cancels what is still in flight, so the deadline is a real cut-off.
    const registered: Promise<unknown>[] = [];
    const passCtx = {
      waitUntil(p: Promise<unknown>) { registered.push(p); },
      passThroughOnException() {},
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("cron deadline")), DEADLINE_MS);
    });
    // Like the runtime's own waitUntil: every registered task settles, also
    // when the request or another task fails; the first failure is reported.
    const pass = (async () => {
      let failure: unknown;
      try {
        const res = await handler.fetch(req, env, passCtx);
        await res.text(); // the body too: a streamed response is still running
        if (!res.ok) failure = new Error(`cron answered ${res.status}`);
      } catch (e) {
        failure = e;
      }
      while (registered.length) {
        for (const r of await Promise.allSettled(registered.splice(0))) {
          if (r.status === "rejected" && failure === undefined) failure = r.reason;
        }
      }
      if (failure !== undefined) throw failure;
    })();
    try {
      await Promise.race([pass, deadline]);
    } finally {
      clearTimeout(timer);
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;

// Only the classes your open-next.config.ts uses (queue, tag cache, purge):
// @ts-ignore
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
```

Calling `handler.fetch` in-process runs the existing route unchanged, with no
network hop and no self-fetch flag. Keep the route's bearer check so a
public request cannot trigger it. Map each `vercel.json` cron to one
`triggers.crons` entry. A `scheduled` handler gets one cron string per event
(`event.cron`), so switch on it when several jobs share the Worker.

**Keep the time limit.** A job that takes a lock sized from `maxDuration`
(say a 70 s lock for a 60 s function) relies on Vercel killing it at 60 s.
`ctx.waitUntil(handler.fetch(...))` with no deadline lets a slow pass outlive
its lock, and the next minute's pass then runs beside it. Race the pass, and
whatever it registers with `waitUntil`, against the deadline as above; a no-op
`waitUntil` would silently drop `after()` work. Put the cron only in the production
environment's `triggers`, and remove it from `vercel.json` in the same change,
or Vercel keeps polling too.

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
| 6 | **Cutover, with no DNS gap.** Ahead of time, lower the DNS-only record's TTL and add a Worker **route** `<host>/*` to the production Worker. A route acts only on proxied traffic, so it does nothing yet. In the window, switch that one record to proxied (orange). From that moment the Worker answers every request and Vercel is no longer contacted. Do not delete the record and then create a Custom Domain: resolvers that query in the gap cache NXDOMAIN for the zone's negative-cache TTL (the SOA minimum), and a lowered record TTL does not shorten that. Keep the domain assigned in the Vercel project. | Section 4 passes. |
| 7 | **Rollback, one step.** Switch the record back to DNS-only. Traffic returns to Vercel within the TTL, and the route goes idle again. The record stays put throughout, so there is nothing to recreate. The Vercel project stays deployable and its env current, through the step 2 push. Never remove the route while the record is proxied: Vercel would then be served through Cloudflare's proxy, which is the case the domain row warns about. | Rehearsed once on the temporary hostname. |
| 8 | **Soak, then retire Vercel.** Leave Vercel deployable for at least a couple of weeks of real traffic and one full cron/billing cycle. Vercel's certificate for the hostname can stop renewing once DNS points away, so the rollback window is weeks, not months. Then remove the domain from Vercel, delete crons and webhooks there, revoke Vercel-only credentials (OIDC roles, tokens), and delete the project. | Nothing references the Vercel project. |

After Vercel is retired (step 8) the route-plus-proxied-CNAME can be replaced by a Workers Custom Domain in a quiet window, accepting the brief record swap, or left as it is.

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
- [ ] Per-IP rate limits and audit logs read the client IP through the shared helper, which picks the header by platform, and that has been tested on both.
- [ ] Cache headers: `_next/static` is immutable (`public/_headers`), HTML is not cached by mistake, and the ISR caches are configured, not defaulted.
- [ ] Error monitoring (Sentry or similar) is initialised for Workers and tagged by platform, so a spike can be traced to one side.
- [ ] WAF, rate-limiting and bot rules exist on the zone. Turnstile site keys allow the hostname.
- [ ] `vercel.json` redirects, rewrites and headers have been moved into `next.config` or `_headers`.
- [ ] Analytics: Vercel scripts gated off on the Worker, and the replacement installed.
- [ ] Cloudflare's edge certificate covers the hostname. Universal SSL covers the apex and first-level subdomains; deeper names need an advanced certificate.
- [ ] The account is on **Workers Paid**. Check the plan in the dashboard (Workers & Pages, Plans); don't infer it from a deploy that worked. A Free-plan Worker deploys and serves, and it kills any request that uses more than 10 ms of CPU. Most server-rendered pages need more than that, worst on a cold isolate. A staging Worker behind Access sees too few visits to show it. So view every dynamic route on staging several times, cold, then count its Workers Logs outcomes (query in section 4): any `exceededCpu` is a stop.
- [ ] Tests that run after a production deploy still test production. A workflow triggered by Vercel's `deployment_status` (environment `Production`) keeps testing the Vercel deployment after the move, and stays green while visitors get the Worker. Run the same suite against the domain from the Worker's deploy job, and retire or relabel the Vercel-triggered one.
- [ ] The route `<host>/*` exists on the production Worker and the record is still DNS-only. The Vercel deployment is current with `main`.

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
- [ ] Workers Logs are watched for the first day **by outcome per script** (`ok`, `exceededCpu`, `exceededMemory`, `exception`, `canceled`), not by curling a few pages. Resource-limit failures are intermittent: the same URL can return 200, then 503, then 200. The query endpoint takes a token with the Workers Observability permission; Cloudflare's API reference lists Write for it:

  ```bash
  now=$(($(date +%s)*1000))
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/observability/telemetry/query" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    -d '{"queryId":"adhoc","timeframe":{"from":'$((now-3600000))',"to":'$now'},"view":"calculations",
         "parameters":{"calculations":[{"operator":"count"}],
         "groupBys":[{"type":"string","value":"$workers.scriptName"},{"type":"string","value":"$workers.outcome"}]}}'
  ```

  `"view":"events"` with a filter on `$workers.outcome` lists the failing URLs, each with its `cpuTimeMs`.
- [ ] The Vercel deployment stays up, current and reachable at its own alias until a full day of clean outcomes. It is the rollback.
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

| Site | Step (0-8) | Staging Worker | Production Worker | Secrets pushed from source | CI both green | Cutover window | Route ready | Owner | Blocker |
|---|---|---|---|---|---|---|---|---|---|
| `<site>` | 4 | `<site>-stage`, Access on | not yet | stage yes / prod no | yes | none yet | no | agent-1 | Worker-only `redirect: "error"` in API client |

A row moves forward only when its step's "done when" is true. The cutover
column is a lock: claim a window there before starting step 6, and clear it
after section 4 passes.

## 6. Lessons from a move under a deadline

From retiring a Vercel team on a billing deadline: three sites, about two hours.
Each line cost a review round or a broken production before it was written down.

- **Data keyed by `VERCEL_ENV`.** Storage namespaces built from it
  (`app:${VERCEL_ENV}:...`) read an empty namespace on a Worker, where it is
  unset, and the site looks fine with no data. Set `VERCEL_ENV=production` in
  the production Worker's `vars` *and* in its build's environment as a bridge,
  and rename the prefixes later. Grep for `VERCEL` (not only `VERCEL_ENV`):
  `process.env.VERCEL` gates self-pollers and analytics too.
- **One build per Worker.** Staging and production from one workflow need two
  builds when any `NEXT_PUBLIC_*` value differs (a VAPID public key, a feature
  flag). Keep production's public values in their own CI variables
  (`PROD_*`) and build the production job with them.
- **Migrations in `npm run build` go quiet.** A build script that applies
  database migrations when the database variables are set, and skips them
  otherwise, skips them on a Worker build: the variables are Worker secrets,
  loaded after the build. Give the production build job the database
  credentials from a CI environment whose deployment policy admits `main` only,
  and pin that in a workflow test.
- **Self-pollers.** Code that starts its own interval loop when it is not on
  Vercel (`instrumentation.ts`'s `register()`) runs in every Worker isolate.
  Give it an explicit off switch and set it on every Worker.
- **What Vercel's edge did for free.** www to the apex and http to https
  (308), and geolocation headers. A custom worker can redo them: redirect in
  `fetch`, and set the Vercel header the app reads from `request.cf`
  (`x-vercel-ip-timezone` from `request.cf.timezone`) after deleting any
  client-sent value. Static assets bypass the worker unless `run_worker_first`
  is set, so they are served on http and on www as they are. The zone's Always
  Use HTTPS covers http only; www to the apex needs a redirect rule (or
  `run_worker_first`), and both need a token that may change the zone.
- **Vercel Analytics.** Render `<Analytics />` only when `process.env.VERCEL`
  is set; on a Worker its `/_vercel/insights` requests 404.
- **Marketplace storage dies with the team.** Upstash stores created through
  the Vercel Marketplace cannot be transferred between Vercel teams (the
  transfer feature listed Prisma, Neon and Supabase), and deleting the team
  deletes them. Back up first, over REST. Upstash serves `DUMP` there, but
  Valkey 8.1 rejects its payloads (`ERR DUMP payload version or checksum are
  wrong`), so for a Valkey target export by type (`SCAN`, `TYPE`, then `GET` / `HGETALL` / `SMEMBERS` /
  `LRANGE 0 -1` / `ZRANGE 0 -1 WITHSCORES` / `XRANGE - +`, plus `PTTL`). A
  stream with consumer groups is more than its entries: the groups' cursors and
  pending (delivered, unacknowledged) entries are not in `XRANGE`, and
  `XINFO GROUPS` gives only a count of the pending ones. Drain or acknowledge
  pending deliveries before the move, or plan a replay. Count the types first
  and refuse to call the backup complete while any type has no exporter. Any Redis behind
  serverless-redis-http speaks Upstash's REST protocol, so `@upstash/redis`
  code runs unchanged against a replacement. The [`upstash-to-valkey`](../upstash-to-valkey/SKILL.md) skill has
  the options with prices, measured latency and failover, and the full
  backup-restore-reconcile procedure.
- **A required `Vercel` check.** Branch rules that require Vercel's status check
  block every merge once the project is gone. Drop it from the required checks
  when production moves.
- **No public production, nothing to move.** A project whose production URL sits
  behind Vercel's own login and has no custom domain serves only the team; the
  Access-protected staging Worker already replaces it. Check environment
  variables nothing reads before you rescue them.
- **Check the edge certificate, twice.** Asking a Cloudflare address for the
  hostname's certificate (`openssl s_client -connect <cloudflare-ip>:443
  -servername <host>`) showed the zone's Universal SSL certificate (apex and
  `*.`) before the records were proxied, but Cloudflare documents serving it
  for proxied records only, so treat that as a hint and check again the moment
  the record is proxied.
- **Compare right after the switch.** Vercel keeps answering for the hostname
  until the project is gone, so compare status codes path by path:
  `curl https://<host>/<path>` against
  `curl --resolve <host>:443:<vercel-ip> https://<host>/<path>`.
- **Permissions per zone.** The token that creates Workers routes needs Workers
  Routes on each zone. Granting it is a change to that token's own policies.
- **Data before secrets.** A cron trigger starts working the moment its Worker
  has its secrets. When the store moves too, restore the data into the new
  store first, then load the secrets, then switch the domain: a first pass
  against an empty store sees no subscribers and no "already sent" records.
  Back up the old store again immediately before the restore, from the
  credential version that still points at it. Old writers keep writing until
  the switch and for the DNS TTL after it (Vercel serving cached clients, a
  scheduled job still holding the old credentials), so either pause them, or
  reconcile afterwards: export the old store again, diff it against the final
  backup, copy each changed key the new store has not rewritten since the
  restore, and merge hashes field by field: a field that changed in the old
  store and still holds the backup's value in the new one is copied (`HSET`),
  one changed on both sides is decided by hand. Compare values, not
  `HGETALL` output, whose field order is not stable. Keep the old store until
  that diff is empty or explained.
- **A self-hosted Upstash replacement works.** Valkey behind
  serverless-redis-http, published through a Cloudflare Tunnel (no inbound
  port), served `@upstash/redis` unchanged: `/pipeline`, `/multi-exec` and the
  `Upstash-Encoding: base64` responses the client asks for. Give each
  environment its own REST token and database number, and check that a wrong
  token is refused. Its fixes, task design and failover numbers are in the
  [`upstash-to-valkey`](../upstash-to-valkey/SKILL.md) skill.
- **A cutover onto the Free plan.** One site moved its domain to a Worker on an
  account still on Workers Free. Deploys succeeded, staging behind Access looked
  fine, and the Vercel-triggered production tests stayed green, because they
  still tested Vercel. Visitors then got intermittent **Error 1102, "Worker
  exceeded resource limits"**: about 1 request in 9, on Home and other
  server-rendered pages and their `?_rsc=` navigations. Workers Logs showed
  outcome `exceededCpu` with `cpuTimeMs` at exactly 10, the Free limit. The fix
  is the plan, not the code or the zone: Workers Paid raises the default to
  30 s. The plan check and the outcome count in sections 3 and 4 exist because
  of this.
- **Compressed soak.** Step 8's soak shrinks to nothing when the team is going
  away. The route and the proxied record keep working after Vercel is gone, but
  the rollback ends with the project: say so when you cut over.

## 7. Running on Workers

Once a site runs on Workers, read [`workers-gotchas.md`](workers-gotchas.md): the runtime traps a move does not show. It covers never sharing I/O or promises across requests, a timeout on every outbound call (Turso/libSQL as the worked case), pages that never wait for ever, reading Workers Logs to tell a hang from an error, and shipping a fix during an outage.

## References

- OpenNext for Cloudflare: https://opennext.js.org/cloudflare (get started, caching, custom worker, images, env vars)
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Compatibility flags: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Preview (Version) URLs: https://developers.cloudflare.com/workers/configuration/previews/
- Custom Domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Vercel request headers: https://vercel.com/docs/headers/request-headers
- Cloudflare in front of Vercel: https://vercel.com/kb/guide/cloudflare-with-vercel
