---
name: mobile-safari
description: What to check when building or changing a website that people use on phones, iPhone Safari above all, and how to test it. Covers forms and AutoFill (autocomplete tokens and sections, insertReplacementText versus spelling corrections, lookups that race or land late), input zoom, a page that scrolls sideways, dvh and safe areas, touch targets and hover, maps in small frames, home-screen installs and their separate storage, location permission and stale first fixes, the screen wake lock across sleep, background tabs, slow phones, and what Playwright's WebKit can and cannot show. Use for any change to a web app's forms, CSS, layout, or anything run on a phone.
---

# Phones and iPhone Safari

A site that works on a laptop can still fail on a phone in ways no desktop test shows. Each
rule below comes from a bug that shipped to a real phone. When a change touches one, fix it
and prove the fix with a check that fails without it. Don't write it down as a known issue.

## Forms and AutoFill

- **Don't turn AutoFill off on a field it should fill.** Safari offers the viewer's saved
  addresses (from their contact card), names, emails and phone numbers only on fields whose
  `autocomplete` token says what they are: `street-address`, `address-line1`, `postal-code`,
  `name`, `email`, `tel`. A place search box with `autocomplete="off"` hides the viewer's own
  home address from them.
- **Two addresses in one form need two sections.** Use `section-from street-address` and
  `section-to street-address`. With one shared token, Chrome treats the two fields as lines 1
  and 2 of a single address, so filling the first fills the second.
- **AutoFill arrives all at once, often as the field loses focus.** Safari sends an `input`
  event with `inputType: "insertReplacementText"`. Chrome's AutoFill usually sends one with no
  `inputType`. Typing gives `insertText`; pasting gives `insertFromPaste`. A field that only acts
  when the viewer picks a suggestion does nothing with an autofilled value. Handle it: look the
  text up and take the first match, or validate it directly.
- **A spelling correction is also `insertReplacementText`.** It swaps one word, while AutoFill
  brings a whole value. Compare words, not lengths: a replacement that swaps exactly one word
  for one word (same word count, one word different) is a correction and stays typing; any
  other replacement is AutoFill. Every length rule fails one way or the other: AutoFill can put
  in a single short word or replace an address with a shorter one, and a correction can change
  nine characters. A correction treated as AutoFill commits a lookup result the viewer never
  chose.
- **One lookup at a time, and drop late answers.** If an autofilled value starts a lookup and
  the same value also starts the suggestion list's search, the later request wins and the
  filled value is lost. Give every lookup one sequence counter. Advance it on every edit and
  whenever the value is set from outside (a saved item tapped, a reset), and when the
  component unmounts (the viewer switches tabs), so a late answer can't refill a field the
  viewer has since cleared or overwrite a newer choice. Keep the list closed for an
  autofilled value.
- **Multi-line values lose their line breaks** in a single-line `<input>`: the street and the
  city run together. Split on a separator you add, not on a newline.
- **Geocoders rank by prominence, not distance.** A short query can list another country above
  the place a mile away. Pass a bounding box (or a strong location bias) around the area the
  app serves.
- **A tap on a suggestion must not blur the field first.** Use
  `onMouseDown={e => e.preventDefault()}` on suggestion buttons. Otherwise the blur closes the
  list before the click lands. A blur timer must read the field's latest state (a ref), not
  the render it was created in.
- **Inputs are at least 16 px.** Smaller text makes iPhone Safari zoom the page when the field
  is focused, and it stays zoomed. Don't fix this with `maximum-scale=1`: that also blocks
  pinch-zoom for people who need it.
- **Native pickers differ.** `<input type="time">` shows a seconds field when its `step` is
  not a whole number of minutes, or when its value or `min` has seconds (`08:10:30`). The
  default step is already 60: keep it a multiple of 60 and keep seconds out of the values. A `<select>` looks different on every platform unless you reset its
  appearance (`appearance: none`) and draw one chevron.
- **Choose the right keyboard.** Use `inputmode` (`numeric`, `decimal`, `email`, `tel`,
  `search`) and `enterkeyhint`, so the phone shows a keyboard that fits the field.

## Layout

- **The page never scrolls sideways.** One wide child widens the whole page. Grid and flex
  children won't shrink below their content unless you allow it:
  `grid-template-columns: minmax(0, 1fr)` and `min-width: 0` on flex children. Then a long
  row scrolls inside itself (`overflow-x: auto`). Popovers and tooltips near the screen's edge
  must be clamped inside it. Test: `document.documentElement.scrollWidth <= innerWidth` at
  320 px (iPhone SE) and 390 px.
- **Use `dvh`, not `vh`.** Safari's toolbars grow and shrink, so `100vh` is taller than what
  shows and puts content under them. Use `100dvh` (`svh`/`lvh` when you mean the small or
  large viewport).
- **Notch and home indicator.** With `viewport-fit=cover` in the viewport meta, pad anything
  at an edge with `env(safe-area-inset-top|right|bottom|left)`. Sticky headers and bottom bars
  need it most.
- **Touch targets are at least 44 × 44 px** under `@media (pointer: coarse)`. An inline text
  link is not a button.
- **Nothing relies on hover.** Phones have no hover. Tips and menus open on tap, and hover
  styles are only a bonus. Also beware `:hover` getting stuck after a tap.
- **The keyboard covers the bottom of the page.** A field near the bottom, or a fixed footer,
  can end up hidden. `visualViewport` gives the visible area.
- **Maps in a frame that changes size** must be resized before they fit bounds to their
  content. Otherwise they frame the old size and cut off the destination. Fold the attribution
  into its compact control on narrow maps.

## Home-screen installs and storage

- **A site added to the home screen has its own storage**, separate from Safari's. Since
  iOS 17.2, installing copies Safari's cookies (so a signed-in viewer stays signed in), but
  `localStorage`, IndexedDB and the rest start empty. Its first screen must be useful with no
  saved state, and you should test both a signed-in and an empty first launch.
- **Installing needs nothing from the site on iOS 26 and later**: any page can be added and
  opens as a web app. A web app manifest (`display: standalone`, name, icons), an
  `apple-touch-icon` and a `theme-color` decide how it looks and opens, and older iOS
  versions rely on them more. Check the icon on a real home screen.
- **`localStorage` can throw** (some private modes, storage full) or be cleared by the system
  after weeks without a visit. Wrap every read and write, and never keep the only copy of
  something that matters there.
- **Load nothing third-party at startup that you could bundle.** Fonts from a font CDN make a
  phone on a weak signal wait. Bundle the fonts (`next/font/local`, `@fontsource`).

## Location, the screen and the background

- **Location needs a secure context and permission.** Ask from a tap that explains why, not
  on page load. A refusal (`PERMISSION_DENIED`) should say how to turn location back on
  (Settings). A timeout or a gap in fixes (a tunnel, a parking garage) is not a refusal: keep
  watching.
- **The first fix can be stale.** The platform may first hand over a cached position, minutes
  old and somewhere else. Drop fixes stamped before the task began (allow a few seconds), or
  your tracking will jump.
- **Keep the screen on with the wake lock** (`navigator.wakeLock.request("screen")`, Safari
  16.4+). The browser releases it whenever the page is hidden, so while it's wanted, take it
  again on `visibilitychange` when the page is visible again. Remove that listener when it's
  no longer wanted. A lock taken only once is gone after the first time the phone sleeps or
  the viewer switches apps.
- **A hidden page stops running.** Timers and location stop in a background tab or on a
  locked phone. Whatever was running must come through the gap without its state breaking,
  and pick up where it left off.

## Slow phones

- **Keep heavy work off the main thread.** Put it in a Web Worker, so taps and scrolling
  stay smooth.
- **Say that it is working.** Show progress in words while the work runs, and show the last
  result straight away when the same thing is asked for again, then refresh it.
- Measure on a real phone or a throttled profile, not a desktop CPU.

## How to test

- **Layout and flows:** Playwright WebKit with an iPhone device profile
  (`devices["iPhone 15"]`, and an iPhone SE or a 320 px width). Run it against a local server
  or a preview deploy. Check for sideways scroll, take screenshots of each screen, and walk
  the main task by tapping. Use the `playwright-core` version whose `browsers.json` matches
  the browser builds you have installed.
- **AutoFill can't be triggered by an automated browser.** Simulate it the way each browser
  sends it: set the value through the native setter, so frameworks like React see the change,
  then dispatch the event and blur:

  ```js
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(input, "1 Example St, Springfield");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" })); // Safari
  // Chrome: input.dispatchEvent(new Event("input", { bubbles: true }));
  input.blur();
  ```

  Also test a spelling correction (type most of a word, then replace it with
  `insertReplacementText`). And test a slow lookup: delay the lookup with
  `page.route(...)`, clear the field while it's out, and check the field stays clear.
- **Wake lock and visibility** can be checked without a browser: stub `navigator.wakeLock`
  and `document`'s `visibilityState` and `visibilitychange`, then play through start →
  hidden → visible → stop. Each take and release should be recorded in order, and nothing
  should be taken after the stop.
- **Real Safari:** the iOS Simulator on a Mac runs real Mobile Safari with its toolbars and
  keyboard (`xcrun simctl openurl <device> <url>`). AutoFill there needs a contact card with
  an address in the simulator's Contacts.
- **What emulation can't show:** the software keyboard covering the page, permission
  prompts, AutoFill's suggestions, real wake-lock behaviour, background suspension, and real
  CPU speed. When you report a change as done, name which of these went untested.
