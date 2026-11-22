---
name: apple-hig-review
description: Use when asked to compare an app's experience with Apple's Human Interface Guidelines (iOS, iPadOS, macOS, watchOS or visionOS, any year's release), to do a design review of a SwiftUI/UIKit/AppKit app, to review a website or web app as it runs in mobile Safari and Chrome (iOS and Android), or to run "a team of researchers" over an app's UI. Parallel reviewers, each owning one area, research the current guidelines from authoritative sources, judge real screenshots and the code, and return ranked, cited, file:line findings that are then consolidated into one report.
---

# Apple HIG review

The reader is the app's owner, deciding what to fix first. For a website or web app, in
mobile Safari, Chrome or both, read `web.md` as well: it sets which sources and rules apply
on the web, how to capture real browsers, and the web checklist. Every finding names the rule,
cites the authoritative source it came from, points at the line of code, and says exactly what to
change. A finding that is the reviewer's own judgment says so. Nothing is pushed, opened or
merged without the user's go-ahead for that step.

## 1. Look before reviewing

Reviewers judge pixels, not just code. Before briefing anyone, capture the real UI:

- **Screens:** every main screen and state (empty, loading, error, the busy state of any
  live feature, sheets, alerts, menus), in light and dark, on the smallest supported
  iPhone width and on iPad or Mac if supported. `scripts/capture.sh` covers a physical
  iPhone or iPad, the booted simulator, and the Mac.
- **Accessibility sizes:** on a simulator,
  `xcrun simctl ui booted content_size accessibility-extra-large` (reset with `large`),
  plus Increase Contrast and Reduce Motion where the feature animates.
- **Code:** list the files behind each screen (views, the scene or app entry, Info.plist
  or XcodeGen keys, entitlements), and the deployment targets. A reviewer's API
  recommendation is useless if it needs a newer OS than the app targets without an
  `#available` check.
- **Every screen, from a seeded build:** a capture walk that taps through the app misses
  states and drifts with the UI. Instead let Debug builds read a stored project (and any photo)
  from the launch environment before the app starts, and write a throwaway XCUITest that, for
  each screen, launches on a seed already at that screen, screenshots it, then swipes up and
  screenshots each scroll position (`XCTAttachment`, `lifetime = .keepAlways`). Run it once per
  variant (iPhone light, dark, accessibility large; iPad), export with `xcrun xcresulttool
  export attachments`, name the files `<device>-<appearance>-<screen>-<n>.png`, and drop
  repeated shots by hash where a screen is too short to scroll. A failing test exports its own
  attachments too ("UI Snapshot", "Synthesized Event"): delete them. iPad puts the tab bar at
  the top, so `app.tabBars` finds nothing there.
- **The comparable Apple app:** name it (Safari for a browser, Mail, Files, Settings).
  Reviewers compare against how it behaves on the release in question.

Screenshots of a real device can contain private pages and secrets (a pairing code, an
account). Keep them in the checkout's `.scratch/`, never in a public place, and do not hand
a reviewer a screenshot that shows a secret.

## 2. Split into areas, one reviewer each

Three to six areas, each owning distinct files and screenshots, so reviewers do not
overlap. For an app with a custom feature on top of standard chrome, a good split is:

1. the app's signature feature (an overlay, an editor, a canvas)
2. the main chrome on iPhone and iPad (toolbars, tab bars, navigation, search)
3. a secondary surface (grids, lists, overviews)
4. settings, onboarding, permissions, sheets and alerts
5. the Mac app as a whole (windows, toolbar, menu bar, Settings scene, keyboard)

Run them in parallel against one frozen tree, and wait for all of them before acting. A
reviewer must not edit files.

### A second, unanchored model

Add one reviewer on a different model (when the owner asks for one, or for a redesign) with
none of the other reviewers' conclusions. Give it the screenshots, the app paragraph and the
lens, and ask for: what the app is really for and whether the design serves it, the one big
reframing idea with a sketch, its top five changes concrete enough to build, and the one thing
everyone will be tempted to do that would be a mistake. When it reaches the same reframe as the
area reviewers independently, that is the strongest signal the review produces.

## 3. The brief

Write the shared part once, to a file every reviewer reads first (the app, the lens, the
architecture rule for where fixes go, the screenshot index and naming, known issues not to
"discover", the deliverable), and keep each reviewer's prompt to its area, files and report path.

When the owner asks for world class rather than compliance ("how would Jony Ive design this"),
say so in the lens: inevitability, reduction, deference (the person's content is the hero),
one obvious next action per screen, typography and layout doing what boxes and color do now,
honest materials (no glass in the content layer), and care in empty and error states. Ask each
reviewer for **the screen as it should be**, with an ASCII sketch at phone width, before the
findings, and to name the Apple apps that solve the same problem best. Keep the rule that a
must-fix cites a source; taste is labelled judgment.

Each reviewer gets the same skeleton, filled in for its area:

- **Role and date:** "a senior <platform> design researcher; today is <date>", naming the
  area's platform (Apple, the web on iOS, the web on Android, accessibility).
- **Research instruction:** research what is current for the named releases and verify
  claims against authoritative sources, citing URLs:
  - the HIG pages at developer.apple.com/design/human-interface-guidelines (each page also
    has a JSON form that fetches reliably);
  - the "What's new" design pages;
  - Apple's API documentation on developer.apple.com, for what an API does and which OS
    it needs;
  - that year's WWDC design and SwiftUI sessions;
  - Apple Support guides, for how Apple's own apps actually behave on that release;
  - for a web area, the sources in `web.md` (WCAG 2.2, the HTML and CSS specs, WebKit,
    Chrome for Developers, Material 3, MDN).

  A must-fix or should-fix rests on one of these. Press reports, blogs, forum answers and
  the reviewer's memory can prompt a check but are not evidence: label such a claim
  unverified, or test it on a device. A rule quoted from a source names the page.
- **The app:** one paragraph on what it is and does.
- **The area:** the exact files (with the main types in each), the screenshots by
  absolute path, and any known bug visible in them, so it is not "discovered" again.
- **What to evaluate**, from the checklist that fits the area (§4 for a native area,
  web.md's for a web one) parts that apply, plus "note what works well". Ask for functional defects too: a design reviewer reading window code found a bug
  where a second window stole the first one's web view.
- **Deliverable:** ONE complete report as the final message, also written to the one
  report file named in the brief (the only file the reviewer may write).
  - A short verdict, then findings ranked by impact, each with severity (must-fix,
    should-fix or nice), the rule with its source URL, the exact file:line, and the
    concrete change (the API or modifier).
  - "Verified from source" (Apple, W3C, the browser vendor, as the area's sources allow)
    kept separate from "your judgment".
  - A word cap (about 900).
  - "Do not modify any file except your report."

## 4. Checklist

Pick what applies to the area:

- **Materials:**
  - Liquid Glass (iOS and macOS 26 and later) is for controls floating above content, not
    the content layer, except transient interactive elements such as a slider or toggle
    while it is being used.
  - The regular variant suits text-heavy elements.
  - Group adjacent glass in a `GlassEffectContainer`.
  - Older OS versions keep a standard material.
- **Layout:**
  - Safe areas, the home indicator, the keyboard, landscape, size classes, iPad
    multitasking, resizable iPhone apps.
  - Controls placed where the comparable Apple app puts them. Search placement depends on
    the screen and task: Apple prefers the bottom on iPhone when there is room, but allows
    a top toolbar or inline search.
- **Targets:** hit regions of at least 44×44 pt (60×60 pt on visionOS), e.g.
  `.frame(minWidth: 44, minHeight: 44)` with a `.contentShape`.
- **Accessibility:**
  - VoiceOver: labels on icon-only buttons; `Button` rather than `onTapGesture`; selected
    and updating traits; element grouping that keeps a destructive control separate;
    announcements when live state changes.
  - Dynamic Type to 200%: no truncated identity labels; stacked layouts at accessibility
    sizes; `@ScaledMetric`.
  - Reduce Motion: no endless rotation, pulsing or scaling; fades instead of slides.
  - Increase Contrast and Reduce Transparency.
  - Never color alone.
- **Color:**
  - Dark mode and contrast.
  - Avoid colors that read as system status: green and orange privacy dots, red errors.
- **Trust and privacy:**
  - Anything a web page or other untrusted content could draw must not be the only trust
    signal. Put it in the app's chrome, as Safari does with its orange toolbar for
    WebDriver sessions.
  - Permission prompts only when the feature is used, specific purpose strings, a denied
    state that points to Settings.
- **Sheets and alerts:**
  - A modal editing sheet is typically `NavigationStack { Form }` with
    `.cancellationAction` and `.confirmationAction` toolbar items; nonmodal and simple
    sheets need not follow that shape.
  - Destructive actions that cannot be undone get a confirmation dialog.
  - Alerts never time out on their own.
  - Titles say what happens; button titles are verbs.
- **macOS:**
  - A system toolbar, not a row inside the content.
  - Window titles that are not the app's name.
  - Menu bar commands for every toolbar item, standard shortcuts (⌘W closes the tab in a
    tabbed window), and a Settings scene (⌘,) instead of settings buttons.
  - Window restoration.
  - Single-window state if the model cannot be shared.
- **Feedback:** haptics for success and failure (`.sensoryFeedback`); error copy in plain
  sentences (`LocalizedError`), never a printed enum.
- **Motion and transitions:** zoom and matched-geometry transitions where the platform
  uses them; pressed states.

## 5. Consolidate

When every reviewer has reported:

- **Deduplicate:** mark how many reviewers raised each finding independently (×N). Two
  reviewers finding the same thing is strong evidence.
- **Rank:** must-fix first; group by theme (motion, targets, trust, sheets, menus), not by
  reviewer.
- **Disagreements:** note them and decide; reviewers may differ on, say, which material a
  card should use.
- **What to doubt:** flag claims from press reports or a single reviewer's reading as
  unverified, and API recommendations that need an OS newer than the deployment target.
- **What works:** list it, so a redesign does not lose it.

Write the consolidated report to one file. Give the user the top must-fixes in a short
list, say where the full reports are, and offer a page they can share.

## 6. Fixing what it found

If asked to fix:

- **Stack PRs by theme:** accessibility and motion; trust signals; sheets and alerts; Mac
  menus and windows; layout redesign last, since it moves the most.
- **Check every fix on a device or simulator:** a before/after screenshot for visual
  changes, and a test where behavior changes. A confirmation dialog appearing, Reduce
  Motion stopping an animation and a label reaching VoiceOver are all testable with
  XCUITest.
- **Gate newer APIs** with `if #available` and keep the older-OS path working.
- **A structural redesign** (fewer screens, controls moved onto the content): write the new
  view model as a contract file first (each screen's fields, which action is the one prominent
  one, which state must survive a restart), change the shared core against it with tests, then
  redraw each host against the contract, in parallel worktrees if there are several. Dump one
  real view of each screen from the core's tests for the host work to build against.
- **Defects a redesign does not remove** go in first or with it, each with a test: they are
  usually data loss or a false statement (see Gotchas).

## Files

- `scripts/capture.sh`: screenshots of a physical iOS device, the booted simulator, or the
  Mac, downscaled for review.
- `web.md`: the web flavor (mobile Safari and Chrome): the order of authority between
  WCAG, the browser and platform conventions, the sources, real-browser captures, and the
  web checklist.
- `scripts/capture-web.mjs`: emulated phone screenshots of web pages in WebKit and Blink,
  light and dark, reduced motion and 320 px reflow (Playwright).

## Gotchas

- **Physical device:**
  - `xcrun devicectl device capture screenshot` works while the device is unlocked.
  - `devicectl` comes with Xcode. When the selected developer directory is the Command
    Line Tools, `xcrun` reports "unable to find utility": select Xcode with `xcode-select`,
    or set `DEVELOPER_DIR` for one command.
  - XCUITest on a physical device needs Settings → Developer → Enable UI Automation. The
    first run then asks for the device passcode on the device, and the runner fails with
    "Timed out while enabling automation mode" until it is entered.
- **Mac:**
  - `screencapture` over SSH fails with "could not create image from display" while the
    Mac is locked.
  - Sending keystrokes with `osascript` needs Accessibility permission.
- **A web view's focus:** depending on the API and the OS, JavaScript injected with
  `evaluateJavaScript` or `callAsyncJavaScript` can count as a user gesture, so an injected
  `focus()` may raise the iOS keyboard. `inputmode="none"` on the field suppresses it for
  fields you control; test on a device.
- **Defects design reviews keep finding** (each needed a code fix, not a restyle):
  - Progress said three times (a large title, "3 of 6", a row of step chips), and chips ticked
    for steps never visited because "done" was derived from data, not from visits.
  - A destructive replace (a new photo) that silently erased the work tied to the old one.
    When the host keeps the new bytes before telling the app, a confirmation afterwards is too
    late: ask before opening the picker, and let the picker open only from the answer.
  - "Checked just now" that never ages, and "checked live for 0 items": derive the words from
    the timestamp and the current time, and say plainly when a check read nothing.
  - Floating glass controls that cover the content they act on at the default zoom; float
    them only when the content can move out from under them.
  - Many prominent buttons on one screen (one per vendor, one per item): give links a style
    from the core, make exactly one primary, and remember which were followed.
- **Accent color:** an `AccentColor` asset does nothing until the target sets
  `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` (generated projects, e.g. XcodeGen, often
  lack it). A lighter accent for dark mode needs a dark label on it; `.borderedProminent`
  keeps white, so measure the contrast and use a button style with its own label color.
- **Icon Composer (`.icon`)** compiles only with Xcode 26 or later; CI images that default to
  an older Xcode fail with "None of the input catalogs contained a matching … app icon set".
  Select the newest Xcode on the image, and fail loudly when none is new enough.

