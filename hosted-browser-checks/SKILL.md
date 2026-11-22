---
name: hosted-browser-checks
description: "Reading prices, stock and delivery times from store pages with a hosted browser (Browserbase or similar), on a schedule or by hand. Plain fetches are blocked or the page is drawn by script; a hosted browser gets the page. Covers: when a browser is needed at all (a Shopify store's product JSON is not), driving the browser over plain DevTools Protocol messages on a WebSocket so the same code runs in Node and a Cloudflare Worker, blocking images and fonts, proxies only for the domains that need them, sites that throttle after a couple of visits (Amazon), reading a store's own buy-box elements before its text, putting the reading of pages in the app's core with tests replayed from saved pages, local pickup counts, measuring browser minutes and proxy bytes before choosing a schedule, and failing closed so a bot check never replaces a good reading. Use when building or debugging a price or stock checker, choosing how often to run one, or adding a store to one."
---

# Hosted-browser checks

The job: for each offer in a catalogue, read what the store's own page says now (price, in
stock, how many, how soon) and keep it, so an app can buy from it. Most of the work is deciding
what not to send through a browser, and making a bad page never overwrite a good reading.

## 1. Fetch the cheapest way that works

- **Shopify stores** answer `https://<store>/products/<handle>.js` to a plain fetch: each
  variant's price in cents and `available`. `available: true` also covers backorders, so take
  the price and a sold-out flag from it and keep the stock words from elsewhere.
- **Everything else** (Amazon, big-box stores, BigCommerce, store pickers) goes through the
  hosted browser: one session for the run, one page at a time, images, media and fonts blocked.
- **Proxies** only where a site refuses direct visits. A per-domain rule (Browserbase:
  `proxies: [{ type: "browserbase", domainPattern: ".*amazon\\.com.*" }]`) keeps the rest direct.
  Try each store without one first; many that block plain HTTP clients load fine in a real browser.
- **Throttling:** some sites serve an empty or home page to one address after two or three
  product pages, proxied or not. Give each of their pages its own short session (a fresh proxy
  address) and one retry when the read is refused. Blocking their scripts saves bandwidth but
  gets blocked too.
- **Local stock:** a store picker usually needs the store in the URL (a `storeid=` query) before
  the page shows a pickup count. A pickup count means "today" only to someone near that store:
  keep shipping time as the offer's time and decide pickup in the app by the person's region.

## 2. Drive the browser with plain CDP

No Playwright is needed, and without it the code runs in a Worker:

1. Create a session over the provider's REST API; it returns a DevTools WebSocket URL.
2. Open it with the standard `WebSocket`. Send `Target.createTarget` (about:blank), then
   `Target.attachToTarget` with `flatten: true`, and use the returned `sessionId` on every
   page-level message.
3. `Page.enable`, `Network.enable`, `Network.setBlockedURLs` (images, fonts, video).
4. For each URL: `Page.navigate`, wait for `Page.loadEventFired` (with a timeout), wait a settle
   time (longer for sites behind a bot check), then `Runtime.evaluate` with `returnByValue` to
   read `document.body.innerText`.
5. Close the target, close the socket, and release the session through the REST API.

A small client keeps a map of pending ids to promises, and listeners keyed by
`<sessionId>:<method>`; when the socket closes, it rejects every pending command.

## 3. Read pages in the core, not in the fetcher

The fetcher hands over text; what it means is a rule, so it lives in the app's core with
tests:

- **Prefer the store's own elements to its text.** Pages differ by product (several offers, a
  "Ships from" with no stock line). Have the browser put a few marked lines first, read from
  the store's buy-box elements (Amazon: `#corePrice_feature_div .a-offscreen`, `#availability`,
  `#mir-layout-DELIVERY_BLOCK`), and read those before falling back to the page text.
- **Words to look for:** "In Stock", "Only N left in stock", "Currently unavailable",
  "N NEW IN STOCK at <store>", "SOLD OUT at <store>", "FASTEST DELIVERY <MON>, <D>", the first
  non-zero price (the sale price when two are shown). Turn delivery dates into days from today,
  taking the soonest when a page offers two (standard and members).
- **Refuse what you cannot read.** A page with neither a price nor a stock word (a robot check,
  a moved page) is refused, and the last good reading stands.
- **Tests replay real pages.** Save the visible text of each store's page once, cut to the
  lines around price and stock, with location lines removed (a proxy's "Delivering to" names a
  place). Make the states a store did not show that day (sold out, a few left) by editing one
  line of a real page, and say so beside the fixtures.
- **Key readings by offer, not by URL.** One product page can hold several offers (a single and a
  case) that differ only by variant.

## 4. Choose the schedule from measurements

Before setting a schedule, run it once and read the provider's usage (Browserbase:
`GET /v1/projects/<id>/usage` gives browser minutes and proxy bytes; subtract a before and an
after). A proxied product page with scripts on can cost a few megabytes. Read cheap, direct
stores often (every two hours), and the proxied, throttling ones once a day; keep every reading,
so the app always has each offer's newest.

## 5. Keep it honest

- Say when stock was checked, from the reading's time and the current time ("2 hours ago"),
  never a fixed "just now".
- A run that read nothing says so, rather than reporting "checked 0 items".
- Log each refused page with its reason, and report the last run's failures where the app or an
  agent can see them.
- Never send a person's address, name or account to a store through the browser.

See the `cloudflare` skill's workers-gotchas.md, "Scheduled work that keeps what it found", for
running this from a Worker with a Durable Object.
