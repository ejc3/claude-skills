# Running on Workers: gotchas

Each item here passed local tests and a Node dev server, then failed on Workers. They are
written as rules, with the symptom that shows you broke one.

## 1. Never share I/O across requests

**Rule.** Nothing that does network I/O lives at module level: no database client, no
"ready" promise, no cached `fetch` promise, no remote key set. Make it per request. Cache only
plain data (booleans, parsed results), and set it only after the work has finished.

**Why.** A Worker isolate serves many requests, but I/O belongs to the request that started it.
Using an I/O object from another request either throws ("Cannot perform I/O on behalf of a
different request") or, when you await a promise whose I/O another request started, never
resolves. The second is worse: nothing throws and nothing times out.

**The trap in code.** This pattern is common and looks correct:

```ts
let ready: Promise<Store> | null = null;
export function store() {
  ready ??= (async () => {
    const db = createClient({ url, authToken });   // libSQL over HTTP
    await migrate(db);                               // I/O in the first request
    return createStore(db);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
```

If the first request's `migrate()` stalls (the database is slow, or that request is cancelled),
every later request in the isolate awaits the same promise for ever. The `.catch` reset never
runs, because a hung promise never rejects, so the isolate stays broken until Cloudflare evicts
it. Other isolates, in other colos, keep working, which makes it look like one user's problem.

**The fix.**

```ts
let migrated = false;                                  // data, not a promise
export async function store() {
  const db = createClient({ url, authToken, fetch: timedFetch() }); // per request; cheap over HTTP
  if (!migrated) { await migrate(db); migrated = true; }           // set only once finished
  return createStore(db);
}
```

Two requests may both run the migrations once at cold start. Write migrations so a second run is
harmless: record each in a table inside the same batch, and treat "already applied" as success.

Other module-level I/O to look for: `createRemoteJWKSet` from `jose` (it shares an in-flight
fetch of the key set), memoised `fetch` promises, SDK clients that keep a connection or a stream
open (WebSocket or HTTP/2 based), and anything created in a top-level `await`.

## 2. Put a timeout on every outbound call

**Rule.** Every call from a Worker to a database or an API has a deadline. With none, a slow
upstream holds the request until the client gives up, and the user sees a page that never
loads.

**Turso / libSQL.** `@libsql/client/web` (the HTTP client Workers need) accepts a `fetch`
option. Wrap it:

```ts
export const timedFetch = (ms = 8000) => (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
  });
createClient({ url, authToken, fetch: timedFetch() });
```

Pick the number from the slowest healthy call (a migration batch at cold start is the usual
one) and say it is a choice. A timed-out call is an error the page can retry. A hung one is an
outage.

**What failure looks like.** Turso's HTTP endpoint sits behind Cloudflare. When it degrades you
get `LibsqlError: SERVER_ERROR: Server returned HTTP status 520` (origin error) or `525` (TLS
handshake), or no answer at all. It can affect one colo's path while others are fine.

**Interactive transactions** over HTTP (`db.transaction()`) hold the database's write lock
across round trips. Keep them to a few statements, or use `db.batch([...], "write")`, which is
one round trip.

## 3. A page must never wait for ever

**Rule.** Client code that shows a loading state gives every request a timeout and turns the
loading state into "Can't reach the server, trying again…" with backoff. A script error shows
an error state, not a blank or loading screen. Old embedded browsers (car screens, kiosks)
matter most here: nobody can open devtools on them.

**Report what you can't see.** Send `window.onerror`, `unhandledrejection`, failed or timed-out
requests and Content-Security-Policy violations (`report-to` / `report-uri`) to a small endpoint
on your Worker. Have it log one structured line per report, with the query string stripped and no
cookies or IPs, and rate-limit it. Those reports then show up in Workers Logs next to the server
side of the same failure.

On Workers with OpenNext, `next.config` `headers()` does not reach static files (`public/`,
`_next/static`). Those take their headers from a `_headers` file in the build output. A CSP set
only in `next.config` misses every static page, so set both.

## 4. Reading Workers Logs

The query API (`POST /accounts/<account>/workers/observability/telemetry/query`, filter on
`$workers.scriptName`) returns one event per request. The fields that matter:

| field | what it tells you |
|---|---|
| `$workers.outcome` | `ok`, `exception`, or `canceled` (the client went away first) |
| `$workers.wallTimeMs` and `$workers.cpuTimeMs` | **a hang is tiny CPU and huge wall time**: 3 ms of CPU over 50–200 s, then `canceled` |
| `$workers.event.response.status` | missing on a cancelled request |
| `$workers.event.request.cf.colo` | which Cloudflare location served it: one colo failing points at a path, not your code |
| `$workers.event.request.headers["user-agent"]` | **who sent it**: filter out your own headless tests (`HeadlessChrome/…`) before you conclude anything |
| a second event with the same `requestId` | `console` lines and runtime warnings. "waitUntil() tasks did not complete within the allowed time" next to a cancelled request means the request was awaiting something that never finished |

Look at the scheduled (cron) events in the same window too: a cron job failing against the same
database at the same moment is the cheapest proof that the upstream was down.

## 5. Shipping a fix during an outage

Work out the emergency path before you need it:

- **Branch rules.** A ruleset that requires a status check, with no bypass actor, refuses even
  an admin merge (`gh pr merge --admin` fails with "Required status check … is in progress").
  The owner can turn the ruleset off through the API, merge, and turn it back on:
  `gh api -X PUT repos/<org>/<repo>/rulesets/<id> -f enforcement=disabled`, then `active`. Save
  the ruleset (`gh api repos/<org>/<repo>/rulesets/<id>`) first, and check afterwards that it
  reads `active`. Do this only on the owner's explicit say-so.
- **Auto-merge** may be off for the repository. Then nothing merges on green by itself; watch
  the check and merge.
- **Deploy only from main** is right, but it means the deploy waits for a CI runner. With a
  small self-hosted pool, cancel CI runs made pointless by the merge (the PR's own run, and
  main's run for the same commit), so the deploy job gets a runner. Rerun main's CI afterwards so
  the commit still gets its record.
- **The deploy credential** should stay where it is (an environment that admits only main). Don't
  try to deploy from a laptop with a copied token.

## References

- Cloudflare: Workers runtime, "Cannot perform I/O on behalf of a different request"
  (https://developers.cloudflare.com/workers/observability/errors/)
- Cloudflare: Workers Logs and the Query API (https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- Cloudflare: 5xx errors from Cloudflare (520, 525) (https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/)
- libSQL TypeScript client (`@libsql/client`), config `fetch` option (https://github.com/tursodatabase/libsql-client-ts)
- `SKILL.md` beside this file, for moving a site onto Workers in the first place.
