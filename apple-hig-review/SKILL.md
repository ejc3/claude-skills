---
name: apple-hig-review
description: Use when asked to compare an app's experience with Apple's Human Interface Guidelines (iOS, iPadOS, macOS, watchOS or visionOS, any year's release), to do a design review of a SwiftUI/UIKit/AppKit app, or to run "a team of researchers" over an Apple-platform UI. Parallel reviewers, each owning one area, research the current guidelines, judge real screenshots and the code, and return ranked, cited, file:line findings that are then consolidated into one report.
---

# Apple HIG review

The reader is the app's owner, deciding what to fix first. Every finding names the rule,
cites the Apple source it came from, points at the line of code, and says exactly what to
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

## 3. The brief

Each reviewer gets the same skeleton, filled in for its area:

- **Role and date:** "a senior Apple-platform design researcher; today is <date>".
- **Research instruction:** research what is current for the named releases and verify
  claims against Apple sources, citing URLs:
  - the HIG pages at developer.apple.com/design/human-interface-guidelines (each page also
    has a JSON form that fetches reliably);
  - the "What's new" design pages;
  - that year's WWDC design and SwiftUI sessions;
  - Apple Support guides, for how Apple's own apps actually behave on that release.
- **The app:** one paragraph on what it is and does.
- **The area:** the exact files (with the main types in each), the screenshots by
  absolute path, and any known bug visible in them, so it is not "discovered" again.
- **What to evaluate**, from the checklist (§4) parts that apply, plus "note what works
  well". Ask for functional defects too: a design reviewer reading window code found a bug
  where a second window stole the first one's web view.
- **Deliverable:** ONE complete report as the final message, also written to the one
  report file named in the brief (the only file the reviewer may write).
  - A short verdict, then findings ranked by impact, each with severity (must-fix,
    should-fix or nice), the rule with its source URL, the exact file:line, and the
    concrete change (the API or modifier).
  - "Verified from Apple source" kept separate from "your judgment".
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

## Files

- `scripts/capture.sh`: screenshots of a physical iOS device, the booted simulator, or the
  Mac, downscaled for review.

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
