#!/bin/sh
# Screenshots for a design review, downscaled so reviewers can read them.
#
#   capture.sh device <out.png>      a connected, unlocked iPhone or iPad (devicectl)
#   capture.sh simulator <out.png>   the booted simulator
#   capture.sh mac <out.png>         the Mac's main display (fails while the Mac is locked)
#
# Run on the Mac. Output is resized to at most 1300 px on its long side.
set -eu
target="${1:?usage: capture.sh device|simulator|mac <out.png>}"
out="${2:?usage: capture.sh device|simulator|mac <out.png>}"
# devicectl and simctl come with Xcode: select it with xcode-select, or set DEVELOPER_DIR.
dir="$(mktemp -d -t hig-capture)"
raw="$dir/raw.png"
trap 'rm -rf "$dir"' EXIT

case "$target" in
device)
  # The first connected physical device.
  id=$(xcrun devicectl list devices 2>/dev/null |
    awk '/physical/ && /connected/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')
  [ -n "$id" ] || { echo "no connected physical device" >&2; exit 1; }
  xcrun devicectl device capture screenshot --device "$id" --destination "$raw" >/dev/null
  ;;
simulator)
  xcrun simctl io booted screenshot "$raw" >/dev/null
  ;;
mac)
  screencapture -x "$raw"
  ;;
*)
  echo "unknown target: $target" >&2
  exit 2
  ;;
esac

sips -Z 1300 "$raw" --out "$out" >/dev/null
echo "$out"
