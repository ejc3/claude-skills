#!/usr/bin/env node
// Emulated phone screenshots of web pages, for the web flavor of a design review.
//
//   node capture-web.mjs <out-dir> <url> [<url> ...]
//
// Needs Playwright where it runs: `npm i playwright` and
// `npx playwright install webkit chromium`.
//
// Each URL is taken full-page as:
//   safari-iphone    WebKit emulating a current iPhone, light, dark, and reduced motion
//   safari-iphone-se WebKit emulating the smallest supported iPhone, light
//   chrome-android   Chromium emulating an Android phone, light and dark
//   reflow-320       320 CSS px wide (WCAG 1.4.10), light
//
// CAPTURE_TZ (an IANA zone, e.g. America/New_York) and CAPTURE_LOCALE (default en-US) set
// the emulated browser's zone and locale. Set the zone the app's users are in: otherwise
// times render in the runner's zone (often UTC), which a reviewer can mistake for a bug.
//
// Emulation shows layout, color and reflow. It does not show the browser's own toolbar,
// the on-screen keyboard, or the OS text size: capture those in a real browser (see web.md).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, webkit } from "playwright";

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
  { name: "safari-iphone", engine: webkit, context: device("iPhone 15", "iPhone 14", "iPhone 13"),
    variants: [{ colorScheme: "light" }, { colorScheme: "dark" }, { colorScheme: "light", reducedMotion: "reduce" }] },
  { name: "safari-iphone-se", engine: webkit, context: device("iPhone SE"), variants: [{ colorScheme: "light" }] },
  { name: "chrome-android", engine: chromium, context: device("Pixel 7", "Pixel 5"),
    variants: [{ colorScheme: "light" }, { colorScheme: "dark" }] },
  { name: "reflow-320", engine: chromium,
    context: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    variants: [{ colorScheme: "light" }] },
];

const place = { locale: process.env.CAPTURE_LOCALE || "en-US",
  ...(process.env.CAPTURE_TZ ? { timezoneId: process.env.CAPTURE_TZ } : {}) };

const slug = (url) => new URL(url).pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";

for (const profile of profiles) {
  // Headless Chromium drops kerning unless hinting is off.
  const args = profile.engine === chromium ? ["--font-render-hinting=none"] : [];
  const browser = await profile.engine.launch({ args });
  try {
    for (const variant of profile.variants) {
      const context = await browser.newContext({ ...profile.context, ...place, ...variant });
      const page = await context.newPage();
      for (const url of urls) {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => page.goto(url, { waitUntil: "load" }));
        const tag = [profile.name, variant.colorScheme, variant.reducedMotion && "reduced-motion"].filter(Boolean).join("-");
        const file = join(outDir, `${slug(url)}-${tag}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
