---
name: drive-mac
description: Using the owner's Mac from a remote agent session - builds, app automation (AppleScript, Chrome), screenshots and clicks (Peekaboo), signing, and sharing the Mac with other agent sessions. Use whenever a task runs anything on the Mac, drives its screen or Chrome, signs or uploads an Apple build, or answers a macOS permission prompt.
---

# Driving the owner's Mac

**How to reach it** (the alias, the route) is machine-local: read `~/.claude/local.md` first. If it is missing, ask.

## What runs where

- **Plain session:** builds, scripts, files, the scratch drive; `osascript` to System Events and Chrome; `peekaboo`.
- **`mac-gui [--timeout S] -- CMD`:** anything needing the login keychain (`codesign`, signed `xcodebuild archive` /
  `-exportArchive`, `security`). A plain session gets `errSecInternalComponent`.

## Sharing the Mac

- **`mac-lease`** before driving the screen or relaunching an app: `mac-lease run NAME -- CMD`, or `take NAME` /
  `release NAME`. `peekaboo` waits while another session holds it (`MAC_LEASE=NAME`).
- **`mac-build`**: at most two heavy builds; `swift`, `xcodebuild`, `xcrun` already go through it.

## Permission prompts

- Click **Allow** on prompts your own work triggers (Automation, Accessibility, Screen Recording, Full Disk Access,
  keychain for signing). Anything asking for Touch ID or a password goes to the owner.
- Never answer another app's dialog (its password prompt, sign-in, Time Machine). Screenshot it and report.

## Chrome (the owner's signed-in browser)

- Take the lease; never relaunch Chrome while another session is mid-flow (it can sign the owner out).
- Your own window, kept by id: `set wid to id of (make new window with properties {mode:"normal"})`, then
  `tell window id wid`. Never touch the owner's tabs; never match tabs by URL alone.
- Check the page's signed-in state; a new window inherits the front window's profile.
- Wrap every call in `with timeout of N seconds`. Wait 8-10 s after a saving click before closing.
- JavaScript timing out (`-1712`) in every window of a profile needs a Chrome relaunch: ask the owner.
- Click through setups the owner asked for. The owner signs in and approves 2FA. Never pay or accept a contract.

## Peekaboo

`peekaboo see --mode screen --no-elements --path /tmp/s.png`; for one window, `peekaboo window list --app
PID:$(pgrep -x "Google Chrome") --json`, then `peekaboo see --window-id ID`.

## Signing and long jobs

Build in a plain session; run only the signing step through `mac-gui`. A job that must outlive the connection (an
upload) runs as a one-off LaunchAgent in `gui/$(id -u)` (`RunAtLoad`, no `KeepAlive`, log to a file, bootout after).
TestFlight goes through the App Store Connect API key, not Chrome. In a script fed on stdin, give inner `ssh` `-n`.

## Setting up another Mac the same way

Run everything from the box that reaches the Mac; the person at the Mac does only the steps marked **(at the Mac)**.

1. **Access** (machine-local details in `~/.claude/local.md`): the Mac dials out (a tunnel), so nothing opens inbound.
   It needs Remote Login on, the box's public key in `~/.ssh/authorized_keys`, and its host key pinned on the box.
2. **Claude Code CLI:** install or `claude update`. Sign-in is per tool (the desktop app's does not carry over): run
   `script -q /tmp/claude-login.log claude auth login` in the background over SSH; the browser on the Mac opens the
   authorize page; **(at the Mac)** click Authorize; it finishes by itself (`claude auth status`).
3. **Shared Claude pool** (if the owner runs one): its Mac setup script gives a `claude-pool` command.
4. **Agent tools:** the repository's Mac tools installer (`mac-gui`, `mac-lease`, `mac-build`, shims, the `peekaboo`
   wrapper; points `xcode-select` at Xcode).
5. **Peekaboo:** copy `~/Applications/Peekaboo.app`, its CLI under `~/Library/Application Support/Peekaboo/` and its
   LaunchAgent (`open -g -a Peekaboo.app`) from a Mac that has them, fixing the home path. **(at the Mac)** grant
   Peekaboo.app Screen Recording, Accessibility and (optional) Event Synthesizing in System Settings > Privacy &
   Security; `peekaboo permissions` shows the result.
6. **`mac-gui` needs passwordless sudo** (it runs `sudo launchctl asuser`). **(at the Mac)** once:
   `echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/$(whoami)`.
