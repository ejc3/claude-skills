---
name: sports-data-provider
description: Building a provider-agnostic sports-data ingest layer and settling on one concrete provider (Ball Don't Lie as the worked example). Use when a project needs scores, schedules, rosters, injuries or stats from a real-world sports API — choosing providers as data behind one interface, keeping private adapters out of a public build, and the normalisation that must sit in front of a deterministic engine (season-year conventions, UTC-vs-local day boundaries, unstarted games by status rather than score, id stability, rate-limit headers). Owner-specific names (the API-key secret, which account, which app uses it) are in a local file the skill reads first.
---

# A provider-agnostic sports-data layer

Real-world sport is data, not a constant. Put every provider behind one interface, pick the
provider from configuration, and let the core import only the interface — never a provider —
so a provider can be swapped, or kept out of a public build, without touching a line of core.

Owner-specific values (the secret id that holds the API key, the cloud account, the internal
app that consumes it) live in `~/.claude/local.md` or the project's private notes. Read those
first; if they are missing, ask. Nothing below names them.

## The shape

- **One interface.** A `LiveScoreSource`-style contract: `{ id; sports: SportPath[];
  fetchDay(day); scoringPlays?(game); standings?(league); poll?() }`. Each capability past
  `fetchDay` is optional, so a thin provider still conforms. The core and callers import this
  interface and a registry — never a provider directory (enforce it with a lint rule).
- **A provider is a directory** that exports `source` implementing the interface. Its `id` is
  both the configuration value that selects it and the stamp written on every record it
  returns, so you can always tell which provider a datum came from.
- **A generated installed-list.** A small script writes `installed.ts` from the provider
  directories that are present. A public or open-source build simply omits the private
  adapter directories and still compiles and runs — the registry falls back to whatever
  covers the sport.
- **A registry selects by configuration.** `sourceFor(sportPath)` reads `PROVIDER_<LEAGUE>`
  (case-insensitive) from the environment, falls back to a named default, then to any
  installed source that covers the sport; it logs once when a configured id is not installed
  and returns null when nothing covers the sport. Keep a parallel selector per capability
  (e.g. `standingsSourceFor`) rather than overloading one.
- **Per-league config is data**, in one table: the provider's path prefix for that league,
  the season-year convention, the provider env name, and the id-mapping table. A build-time
  pipeline in another language mirrors the same table rather than re-deciding anything.

## Ball Don't Lie, the worked provider

- Base URL `https://api.balldontlie.io`. Auth is the header `Authorization: <raw key>` — **no
  `Bearer` prefix**. The key is server-side only; never expose it to a client bundle.
- The key is a **late-bound secret**: its name lives in configuration, its value in a secrets
  manager, resolved at runtime. Never print it, put it on a command line, or commit it.
- Paths carry a league prefix (`/nfl/v1/...`, `/ncaaf/v1/...`, `/nhl/v1/...`, `/v1/...` for
  the NBA). **Filter names and values differ by league**, so they belong in the per-league
  table, not in shared code. The NFL's `games` takes `dates[]`, `seasons[]`, `season_types[]`
  (1 pre, 2 regular, 3 post), `weeks[]`, `team_ids[]`; the NBA's takes a singular `season_type`
  with string values (`preseason`, `playoffs`) and leaves preseason out unless asked; the NHL's
  has `postseason`. Read each league's own documentation before writing its row.
- **Pagination is cursor-based:** `meta.next_cursor` drives `?cursor=`; `per_page` maxes at
  100. A `next_cursor` that is absent or `null` means the last page: the fetch is complete. Fail
  closed only on a cursor that is present, non-null and not an integer, and cap the page count.
- **Read the `x-ratelimit-*` headers; do not assume the tier.** Limits differ by sport and by
  plan, and a nominal plan can report a far lower live limit on a trial. Some endpoints are
  plan-gated (for the NFL, `plays`, win-probability and standings are on the top tier only).
  Throttle to the observed limit; on a 429, wait for the window and retry a bounded number of
  times, else stop the run on last-good data.
- Ball Don't Lie carries **no broadcast/TV field** on any game. That has to come from another
  provider if you need it.

## The gotchas that bite

- **Season-year conventions differ by provider.** Ball Don't Lie labels a season by its
  **start** year; some providers (e.g. ESPN) use the **end** year. Normalise to one convention
  in the model layer, from the per-league table, before anything compares seasons.
- **Date filters are UTC, not local.** `dates[]` selects by UTC calendar date; one local-time
  game day spans two UTC dates. Query both and re-bucket to the local day. Get this wrong and
  a late game lands on the wrong day.
- **Decide "not started" from the game's status, never from the score.** How a pre-game score
  arrives differs by league: the NFL's is `null`, while the NCAAF's can be `0` with a pre-game
  status. So normalise scheduled games by status (and period, where the league has one), keep a
  real `0` for a game that has started, and treat a `null` score on an in-progress or final game
  as malformed: drop it, do not coerce it to `0`.
- **Pin ids with an explicit table.** Map teams and players through a frozen allowlist and drop
  (do not guess) anything outside it. Abbreviations are not unique below a league's top
  division; namespace a colliding id (`<provider>:<id>`). For an exact-parity goal, build this
  table on day one with collision handling.

## In front of a deterministic engine

If the scores feed a deterministic core (one that must compute the same bytes on every host),
the adapter does the work the core must never see:

- Convert the provider's floats, local-time buckets and quirks to **exact integers** and a
  canonical shape. No float, clock read, locale or map-iteration order crosses into the core.
- Treat **every provider timestamp as a recorded input**, stamped into the log, not read from
  a wall clock at fold time.
- **Every call to a provider is a GET.** A sports-data provider is read-only; there is no write
  path. Keep credentials out of logs and out of the tree.

A live scoreboard can be loose — floats, wall-clock day buckets, throw-on-error polling are
fine there. A parity or ledger engine cannot; the adapter is the boundary between the two.
