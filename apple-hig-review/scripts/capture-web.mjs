#!/usr/bin/env node
// Emulated phone screenshots of web pages, for the web flavor of a design review.
//
//   node capture-web.mjs <out-dir> <url> [<url> ...]
//
// Run it from a project that has Playwright installed (`npm i playwright`, then
// `npx playwright install webkit chromium`): Playwright is loaded from the current
// directory, not from this script's.
//
// Each URL is taken full-page as:
//   webkit-iphone     WebKit emulating a current iPhone: light, dark, and reduced motion
//   webkit-iphone-se  WebKit emulating the smallest iPhone current iOS supports (375 pt): light
//   chromium-android  Chromium emulating an Android phone: light and dark
//   reflow-320        a desktop browser 320 CSS px wide, as WCAG 1.4.10 describes: light
//
// CAPTURE_TZ (an IANA zone, e.g. America/New_York) and CAPTURE_LOCALE (default en-US) set
// the emulated browser's zone and locale. Set the zone the app's users are in: otherwise
// times render in the runner's zone (often UTC), which a reviewer can mistake for a bug.
//
// What emulation shows: layout, color, contrast and reflow. What it does not: the
// browser's own toolbar, the on-screen keyboard, the OS text size, and, on Linux, Apple's
// system fonts. WebKit here is not Safari, so text may wrap differently than on an iPhone.
// Check anything that depends on those in a real browser (see web.md).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const { chromium, devices, webkit } = require("playwright");

const [outDir, ...urls] = process.argv.slice(2);
if (!outDir || urls.length === 0) {
  console.error("usage: capture-web.mjs <out-dir> <url> [<url> ...]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// The first device name this Playwright knows, so a renamed descriptor fails loudly.
function device(...names) {
  const name = names.find((n) => devices[n]);
  if (!name) throw new Error(`no Playwright device among: ${names.join(", ")}`);
  return devices[name];
}

const profiles = [
  { name: "webkit-iphone", engine: webkit, context: device("iPhone 17", "iPhone 16", "iPhone 15", "iPhone 14"),
    variants: [{ colorScheme: "light" }, { colorScheme: "dark" }, { colorScheme: "light", reducedMotion: "reduce" }] },
  { name: "webkit-iphone-se", engine: webkit, context: device("iPhone SE (3rd gen)"),
    variants: [{ colorScheme: "light" }] },
  { name: "chromium-android", engine: chromium, context: device("Pixel 7", "Pixel 5"),
    variants: [{ colorScheme: "light" }, { colorScheme: "dark" }] },
  // Not a phone: 1.4.10 is a desktop browser at 1280 px zoomed to 400%. Mobile emulation
  // would lay a page without a viewport tag out at 980 px and shrink it, hiding a failure.
  { name: "reflow-320", engine: chromium,
    context: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
    variants: [{ colorScheme: "light" }] },
];

const place = { locale: process.env.CAPTURE_LOCALE || "en-US",
  ...(process.env.CAPTURE_TZ ? { timezoneId: process.env.CAPTURE_TZ } : {}) };

// A file name per URL is its position in the argument list, and nothing from the URL: a path
// or query can carry a token or an account id, and a file name travels with a shared
// screenshot. The list printed here says which number is which page.
const slug = (index) => String(index + 1).padStart(2, "0");
urls.forEach((url, index) => console.log(`${slug(index)}  ${url}`));

let failures = 0;
for (const profile of profiles) {
  // Headless Chromium drops kerning unless hinting is off.
  const args = profile.engine === chromium ? ["--font-render-hinting=none"] : [];
  const browser = await profile.engine.launch({ args });
  try {
    for (const variant of profile.variants) {
      const context = await browser.newContext({ ...profile.context, ...place, ...variant });
      const page = await context.newPage();
      for (const [index, url] of urls.entries()) {
        const tag = [profile.name, variant.colorScheme, variant.reducedMotion && "reduced-motion"].filter(Boolean).join("-");
        const file = join(outDir, `${slug(index)}-${tag}.png`);
        try {
          const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
          // Let late requests settle, but never wait long on a page that keeps a request open.
          await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
          const status = response?.status();
          if (status && status >= 400) console.warn(`warning: ${url} answered ${status}`);
          await page.screenshot({ path: file, fullPage: true });
          console.log(file);
        } catch (error) {
          failures += 1;
          console.error(`failed: ${url} (${tag}): ${error.message.split("\n")[0]}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
process.exit(failures ? 1 : 0);
