#!/usr/bin/env bash
# Cases for same-change.sh, each written against the unfixed script first.
set -uo pipefail
SCRIPT=${1:?usage: test-same-change.sh <path to same-change.sh>}
SCRIPT=$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")
pass=0; fail=0

scratch() {
  local root
  root=$(mktemp -d)
  git -C "$root" init -q -b main
  git -C "$root" config user.email t@example.invalid
  git -C "$root" config user.name t
  echo base > "$root/file.txt"
  git -C "$root" add -A && git -C "$root" commit -qm base
  echo "$root"
}

check() { # name expected-exit args...
  local name=$1 want=$2; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); printf 'ok   %s\n' "$name"
  else fail=$((fail+1)); printf 'FAIL %s (exit %s, wanted %s)\n' "$name" "$got" "$want"; fi
}

root=$(scratch)
# A branch with one real change.
git -C "$root" checkout -q -b work
echo mine > "$root/mine.txt"
git -C "$root" add -A && git -C "$root" commit -qm "the change"
reviewed=$(git -C "$root" rev-parse HEAD)
# main moves underneath it.
git -C "$root" checkout -q main
echo theirs > "$root/theirs.txt"
git -C "$root" add -A && git -C "$root" commit -qm "somebody else"
git -C "$root" checkout -q work
git -C "$root" merge -q --no-edit main
updated=$(git -C "$root" rev-parse HEAD)

check "an update-merge carries the review forward" 0 \
  env GIT_DIR="$root/.git" GIT_WORK_TREE="$root" bash "$SCRIPT" main "$reviewed" "$updated"

# The same merge, plus one extra edit smuggled in.
echo sneaky >> "$root/mine.txt"
git -C "$root" add -A && git -C "$root" commit -qm "while I was here"
smuggled=$(git -C "$root" rev-parse HEAD)
check "an edit alongside the merge does not" 1 \
  env GIT_DIR="$root/.git" GIT_WORK_TREE="$root" bash "$SCRIPT" main "$reviewed" "$smuggled"

check "an unknown commit is not carried forward" 1 \
  env GIT_DIR="$root/.git" GIT_WORK_TREE="$root" bash "$SCRIPT" main 0000000000000000000000000000000000000000 "$updated"

# The same logical change with only whitespace added: patch-id --stable
# calls this the same patch, but --verbatim (used here) keeps whitespace
# significant and calls it a different patch. The tree differs (a formatter
# would flag it), so the gate must not carry the review forward.
git -C "$root" checkout -q "$updated"
printf 'mine \n' > "$root/mine.txt"
git -C "$root" add -A && git -C "$root" commit -qm "trailing whitespace"
whitespace=$(git -C "$root" rev-parse HEAD)
check "a whitespace-only difference is not carried forward" 1 \
  env GIT_DIR="$root/.git" GIT_WORK_TREE="$root" bash "$SCRIPT" main "$reviewed" "$whitespace"

# The same change with the merge base moved underneath it: prepending one
# line on main shifts every hunk line number without touching the change.
# Byte-hashing the diff calls this a different patch (line numbers are
# bytes); patch-id --verbatim normalizes the hunk line numbers away, so
# the gate must carry the review forward.
root2=$(mktemp -d)
git -C "$root2" init -q -b main
git -C "$root2" config user.email t@example.invalid
git -C "$root2" config user.name t
seq 1 20 > "$root2/file.txt"
git -C "$root2" add -A && git -C "$root2" commit -qm base
git -C "$root2" checkout -q -b work
sed -i 's/^15$/FIFTEEN/' "$root2/file.txt"
git -C "$root2" add -A && git -C "$root2" commit -qm "the change"
reviewed2=$(git -C "$root2" rev-parse HEAD)
git -C "$root2" checkout -q main
sed -i '1i HEADER' "$root2/file.txt"
git -C "$root2" add -A && git -C "$root2" commit -qm "somebody else"
git -C "$root2" checkout -q work
git -C "$root2" merge -q --no-edit main
updated2=$(git -C "$root2" rev-parse HEAD)

check "a line-number shift from a moved merge base is the same change" 0 \
  env GIT_DIR="$root2/.git" GIT_WORK_TREE="$root2" bash "$SCRIPT" main "$reviewed2" "$updated2"

# Indentation is the whole change. `git patch-id --stable` strips whitespace
# before hashing, so a merge that moved a statement into an `if` block -- or a
# YAML step under a different key -- hashed identical to one that did not, and
# the review of the earlier commit was carried onto code that means something
# else. Python and YAML are both in this repo and both decide meaning by
# indentation, which is why this is the case that matters.
indent_root=$(scratch)
git -C "$indent_root" checkout -q -b work
printf 'def f():\n    a = 1\n' > "$indent_root/m.py"
git -C "$indent_root" add -A && git -C "$indent_root" commit -qm "a function"
indent_reviewed=$(git -C "$indent_root" rev-parse HEAD)
printf 'def f():\n    a = 1\n    b = 2\n' > "$indent_root/m.py"
git -C "$indent_root" add -A && git -C "$indent_root" commit -qm "inside the function"
indent_inside=$(git -C "$indent_root" rev-parse HEAD)
git -C "$indent_root" reset -q --hard "$indent_reviewed"
printf 'def f():\n    a = 1\nb = 2\n' > "$indent_root/m.py"
git -C "$indent_root" add -A && git -C "$indent_root" commit -qm "at module level"
indent_outside=$(git -C "$indent_root" rev-parse HEAD)

check "a statement moved out of a block is not the same change" 1 \
  env GIT_DIR="$indent_root/.git" GIT_WORK_TREE="$indent_root" bash "$SCRIPT" main "$indent_inside" "$indent_outside"

check "a missing base is not carried forward" 1 \
  env GIT_DIR="$root/.git" GIT_WORK_TREE="$root" bash "$SCRIPT" no-such-ref "$reviewed" "$updated"

rm -rf "$root" "$root2" "$indent_root"
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
