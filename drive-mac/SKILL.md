---
name: drive-mac
description: Using the owner's Mac from a remote agent session - builds, app automation (AppleScript, Chrome), screenshots and clicks (Peekaboo), signing, and sharing the Mac with other agent sessions - and setting up another Mac or a Windows PC the same way. Use whenever a task runs anything on the Mac, drives its screen or Chrome, signs or uploads an Apple build, answers a macOS permission prompt, or sets up a new Mac or Windows PC for remote use.
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
4. **Agent tools:** the Mac tools installer (`~/.claude/local.md` names where it lives) (`mac-gui`, `mac-lease`, `mac-build`, shims, the `peekaboo`
   wrapper; points `xcode-select` at Xcode).
5. **Peekaboo:** copy `~/Applications/Peekaboo.app`, its CLI under `~/Library/Application Support/Peekaboo/` and its
   LaunchAgent (`open -g -a Peekaboo.app`) from a Mac that has them, fixing the home path. **(at the Mac)** grant
   Peekaboo.app Screen Recording, Accessibility and (optional) Event Synthesizing in System Settings > Privacy &
   Security; `peekaboo permissions` shows the result.
6. **`mac-gui` needs passwordless sudo** (it runs `sudo launchctl asuser`). **(at the Mac)** once:
   `echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/$(whoami)`.

## Setting up a Windows PC

The person at the PC does one paste and sends one line back; everything else runs from the box.

1. **Access: a reverse SSH tunnel to the box.** The PC dials out, so no router port is opened. Give the
   person one PowerShell script for a window opened with **Run as administrator**, behind a Copy button (an
   artifact page cannot start a download). Wrap the whole script in `& { ... }`: pasted lines run one at a
   time, so a `throw` outside a block lets the rest run anyway. The script:
   - installs the SSH server (`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, silent for 2-10
     minutes; tell the person to wait), then `Set-Service sshd -StartupType Automatic` and `Start-Service sshd`;
   - closes it to the network: the install enables the firewall rule `OpenSSH-Server-In-TCP` (TCP 22) and the
     server accepts passwords by default. Put `ListenAddress 127.0.0.1`, `PasswordAuthentication no` and
     `ChallengeResponseAuthentication no` (not its newer name `KbdInteractiveAuthentication`, which the OpenSSH
     8.1 of older Windows 10 builds rejects) before any `Match` block in `C:\ProgramData\ssh\sshd_config`, check it
     with `sshd -t`, disable the rule, and restart `sshd`;
   - makes Windows PowerShell the server's shell (`DefaultShell` under `HKLM:\SOFTWARE\OpenSSH`);
   - adds the box's public key to `C:\ProgramData\ssh\administrators_authorized_keys` (the only file sshd reads
     for an administrator; ACL Administrators and SYSTEM only) and to `~\.ssh\authorized_keys`;
   - makes the PC's own key with `Start-Process ssh-keygen -Wait -PassThru -ArgumentList '... -N "" ...'` and
     checks its `ExitCode` (one command-line string: on PowerShell 7.3+, `-N '""'` passes two quote characters
     as the passphrase);
   - pins the box's host key in a known_hosts file of its own, registers a logon task that loops
     `ssh -N -R 127.0.0.1:<port>:127.0.0.1:22 -o BatchMode=yes -o ExitOnForwardFailure=yes` with a pause, and
     starts it with `Start-ScheduledTask` (a logon trigger does not fire for the session already open);
   - prints the PC's public key and the user name, and copies them to the clipboard.
2. **On the box:** claim the port in the port registry, then authorize the PC's key for the reverse forward
   only: `restrict,port-forwarding,permitlisten="127.0.0.1:<port>",permitopen="127.0.0.1:1",command="/bin/false"
   ssh-ed25519 ...`. `permitlisten` limits `-R`; without `permitopen` the key could also `-L`/`-D` from the box
   (to its cloud metadata endpoint, say), and `permitopen="none"` makes sshd refuse the key outright. The tunnel
   comes up by itself within seconds. Add an ssh alias (`HostName 127.0.0.1`, the port, a `HostKeyAlias`, its
   own `UserKnownHostsFile`) and record it in `~/.claude/local.md`.
3. **Running commands there:** the shell is Windows PowerShell 5.1.
   - Send a script as `powershell -NoProfile -NonInteractive -EncodedCommand <base64 of UTF-16LE>` and data on
     stdin (`[Console]::In.ReadToEnd()`): nothing needs quoting through ssh, and a secret never reaches a command
     line. `exit 1` or a `throw` comes back as ssh's exit status.
   - Set `$ProgressPreference = 'SilentlyContinue'`, or progress arrives as CLIXML on stderr.
   - Under `$ErrorActionPreference = 'Stop'`, a native program's stderr redirected with `2>&1` ends the
     script. Run native programs with `'Continue'` and check `$LASTEXITCODE`.
   - Check PowerShell you send with `[System.Management.Automation.Language.Parser]::ParseInput` on the PC first.
   - A process started from the SSH session dies with it. To restart `sshd` itself, start a one-off scheduled
     task as `SYSTEM`, then delete it.
4. **Claude Code CLI:** `irm https://claude.ai/install.ps1 | iex` installs into `%USERPROFILE%\.local\bin`, which
   is not on the PATH: add it to the user PATH (`[Environment]::SetEnvironmentVariable('Path', ..., 'User')`).
   Sign in with `claude auth login` over SSH; a browser may not open from an SSH session, so give the person the
   URL it prints.
5. **Shared Claude pool** (if the owner runs one): its Windows setup script. Give the PC an access token of its
   own rather than copying another machine's, and switch the PC over only after a request through its tunnel
   succeeds: the pool's agent fails closed.
