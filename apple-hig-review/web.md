# The web flavor: a site or web app on mobile Safari and Chrome

Read this when the thing under review runs in a browser, alone or beside a native app. The
process in `SKILL.md` is the same: look first, split into areas, brief each reviewer the
same way, consolidate. For fixing what the review finds on iPhone Safari (AutoFill, input zoom
and the other bugs that only show on a phone, with how to test each), use the
`mobile-safari` skill alongside this one. Three things differ: the sources a finding may rest on, the
captures, and the checklist.

## Which rule wins

A web app on a phone answers to three bodies of guidance at once. When they disagree, say
which one a finding rests on and apply them in this order:

1. **Requirements:** W3C's Web Content Accessibility Guidelines (WCAG) 2.2, level AA. A
   failure here is a must-fix wherever the app runs.
2. **The browser's own behavior:** what the engine actually does (WebKit on every iOS
   browser, Blink on Chrome for Android). A design that fights it breaks.
3. **Platform conventions:** Apple's HIG for how an iPhone app feels, Material 3 for
   Android. A web app borrows them where they help the user; it does not imitate system UI
   (an alert, a share sheet, the address bar), because a page that can draw system UI can
   fake it.

## Authoritative sources

Every must-fix and should-fix cites one of these, with the URL and, for a spec, the
section or success-criterion number. Anything else (a blog, a press report, a forum
answer, a reviewer's memory of how something "usually" works) can prompt a check but is
not evidence: label it unverified or test it on a device.

| Topic | Source |
|---|---|
| Accessibility requirements | WCAG 2.2, w3.org/TR/WCAG22, and its Understanding documents, w3.org/WAI/WCAG22/Understanding |
| Roles, names, keyboard patterns | WAI-ARIA 1.2, w3.org/TR/wai-aria-1.2, and the ARIA Authoring Practices Guide, w3.org/WAI/ARIA/apg |
| HTML semantics, forms, `autocomplete`, `inputmode` | the WHATWG HTML standard, html.spec.whatwg.org |
| CSS features and media queries | the W3C CSS specifications (drafts.csswg.org), e.g. Media Queries Level 5 for `prefers-reduced-motion` and `prefers-contrast` |
| iOS conventions | Apple's HIG, developer.apple.com/design/human-interface-guidelines |
| Safari and WebKit behavior | webkit.org (the WebKit blog and its feature announcements), Safari release notes on developer.apple.com, and Apple Support guides for user-facing behavior |
| Android conventions | Material 3, m3.material.io, and developer.android.com |
| Chrome behavior | developer.chrome.com (Chrome for Developers) and web.dev, both Google's |
| Support and exact API facts | MDN, developer.mozilla.org, and its browser compatibility data |

Two cautions:

- **Releases move.** Browser behavior changes with OS and browser releases (the address
  bar's position, what `theme-color` tints, what Add to Home Screen does). Check the
  release the app's users run and cite that year's source, not one remembered.
- **Engines on iOS.** Chrome, Firefox and Edge on iOS use WebKit, except where Apple's
  regional rules let a browser ship its own engine. "Chrome on mobile" therefore means two
  reviews: Chrome on iOS (WebKit, Safari's rules, Chrome's own toolbar) and Chrome on
  Android (Blink, Material conventions).

## Captures

Judge real pixels, as for a native app, in at least these:

- **Mobile Safari:** the iOS Simulator's own Safari on the Mac (`xcrun simctl openurl
  booted <url>`, then `scripts/capture.sh simulator <out.png>`), on the smallest
  supported iPhone and on a current one. This shows the real toolbar, the safe areas and
  the keyboard. A physical iPhone is better still for the keyboard and scrolling.
- **Mobile Chrome on Android:** the Android Emulator if one is set up; otherwise a Blink
  browser emulating a phone (`scripts/capture-web.mjs`), and say in the report that the
  browser's own toolbar and keyboard are not in the picture.
- **Emulated captures for breadth:** `scripts/capture-web.mjs` takes each page at phone
  widths in WebKit and Blink, light and dark, and with reduced motion. Emulation is right
  for layout, color, contrast and reflow. It does not show the browser's toolbar, the
  keyboard, or how the OS text size reaches the page, and WebKit on Linux is not Safari:
  it has none of Apple's system fonts, so wrapping and truncation can differ from an
  iPhone. Call these captures emulated, never Safari evidence, and confirm a wrapping or
  truncation finding in the Simulator.
- **Reflow:** 320 CSS px wide in a desktop browser (not phone emulation, which shrinks a
  page that has no viewport tag), which WCAG 1.4.10 equates with 400% zoom at 1280 px.
- **Text size:** 200% text (WCAG 1.4.4). On iOS that is Safari's page zoom or the system
  text size if the site follows it (WebKit's `font: -apple-system-body`); on Android,
  Chrome's text scaling setting.
- **States:** empty, loading, error, offline, the keyboard up on every form, a sheet or
  dialog open, and the page after the back button (the back/forward cache).

## Checklist

Pick what applies to the area.

- **Targets and gestures:**
  - WCAG 2.5.8 (AA): targets at least 24×24 CSS px, or spaced so that a 24 px circle
    centred on each undersized target intersects neither another target nor another
    undersized target's circle (with the criterion's listed exceptions).
  - Platform comfort sizes are larger: 44×44 pt in Apple's HIG, 48×48 dp in Material.
    Treat them as should-fix for primary controls.
  - WCAG 2.5.7 (AA): anything done by dragging has a single-pointer alternative.
- **Viewport and safe areas:**
  - `<meta name="viewport" content="width=device-width, initial-scale=1">`, never
    `user-scalable=no` or `maximum-scale=1` (WCAG 1.4.4).
  - With `viewport-fit=cover`, pad fixed bars by `env(safe-area-inset-*)`.
  - Full-height layouts use the dynamic viewport units (`dvh`, `svh`) rather than `100vh`,
    which on mobile ignores the collapsing toolbar.
  - Fixed and sticky bars must not hide the focused control entirely (WCAG 2.4.11, AA;
    hiding any part of it fails only 2.4.12, AAA), and must not sit under the on-screen
    keyboard. Chrome on Android's `interactive-widget` viewport key
    and the Visual Viewport API are the tools; check what each engine supports.
- **Text:**
  - Text resizes to 200% without loss (1.4.4) and reflows at 320 px (1.4.10).
  - Form fields on iOS: Safari zooms the page when a field with text smaller than 16 px is
    focused. This is observed behavior rather than a documented rule, so confirm it on a
    device before calling it a defect.
- **Color and contrast:**
  - 4.5:1 for text, 3:1 for large text (1.4.3), and 3:1 for control boundaries, focus
    indicators and meaningful graphics (1.4.11). Never color alone (1.4.1).
  - Light and dark via `prefers-color-scheme`, with `color-scheme` declared so form
    controls and scrollbars match. `theme-color` per scheme where the browser uses it.
- **Motion:** honor `prefers-reduced-motion`. No autoplaying motion over five seconds
  without a control (2.2.2); animation started by interaction can be turned off (2.3.3,
  AAA, should-fix).
- **Semantics and focus:**
  - Native elements first: `<button>` for actions, `<a href>` for navigation, labels on
    every field (1.3.1, 4.1.2), landmarks, and headings that describe the sections (2.4.6).
    A single `h1` is common practice, not a requirement of WCAG or HTML.
  - Icon-only controls have accessible names (4.1.2). Status messages (a result count,
    "saved", an error summary) reach assistive technology without moving focus (4.1.3).
    A live score is not a status message under 4.1.3; announcing it is judgment, and
    should be polite and rate-limited.
  - A visible focus indicator (2.4.7). Dialogs trap focus and return it on close (APG
    dialog pattern).
  - Hover-only affordances do not exist on touch; gate them with `@media (hover: hover)`.
- **Forms:** correct `type`, `autocomplete` tokens (1.3.5) and `inputmode` so the right
  keyboard appears; `enterkeyhint` where the return key's label matters; an input error
  identified and described in text (3.3.1). Tying the message to its field
  (`aria-describedby`) is good practice beyond 3.3.1.
- **Navigation:** the back button and back gestures return to the previous view and its
  scroll position. Client-side routes are real URLs, so pages can be shared and reloaded.
  A page restored from the back/forward cache re-checks anything time-sensitive.
- **Home Screen and installed mode:** a web manifest and `apple-touch-icon`; the
  standalone display mode has no browser back button, so the app needs its own. Web Push
  on iOS and iPadOS works only for a site added to the Home Screen (WebKit, 2023): ask for
  notification permission only from a user gesture, after explaining why.
- **Trust:** never draw something that looks like the browser's or the OS's UI (an address
  bar, a lock, a system alert, a share sheet). Use the real ones: `alert`/`confirm` sparingly,
  the Web Share API for sharing.
- **Performance, as users feel it:** web.dev's Core Web Vitals thresholds (LCP 2.5 s, INP
  200 ms, CLS 0.1), measured on a phone-class profile. Layout shift is also a design bug.
- **Comparable apps:** compare with how the same task feels in Safari's own UI and a
  well-made native app for the domain on each platform, as in the native review.

## Splitting a web review

A good split for a site with a native sibling:

1. mobile Safari (and Chrome on iOS, which shares its engine): layout, safe areas,
   toolbars, keyboard, Home Screen mode;
2. Chrome on Android: the same surfaces against Material conventions and Blink's behavior;
3. accessibility across both, against WCAG 2.2 AA, with the code;
4. parity with the native app: where the two disagree in words, order or behavior, and
   which one is right.
