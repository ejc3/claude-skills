#!/usr/bin/env bash
# Do two commits introduce the SAME change relative to a base?
#
#   same-change.sh <base-ref> <reviewed-sha> <head-sha>
#
# Exit 0 when they do, 1 when they differ or when anything cannot be
# established. This exists for one situation: the repository ruleset requires
# a branch be up to date with `main`, and updating it moves the head, which
# leaves the review-coverage check looking at a commit nobody reviewed. The
# two rules fight, and the loser is whoever is trying to merge.
#
# A merge of the base into the branch adds the base's commits and nothing
# else, so the change the PR is proposing is unchanged and the review of
# the earlier commit still describes the code being merged.
#
# Compared by PATCH-ID, not by "the head is a merge commit". A merge that
# also edited a file is a different patch and gets no carry-forward -- which
# is the case that matters, because that is how an unreviewed change would
# ride in. Compared with `git patch-id --verbatim`: unlike `--stable`, it
# keeps whitespace significant, so a whitespace-only difference is still a
# different patch (and the format check would flag the tree anyway); the hunk
# line numbers that shift when the merge base moves are normalized away, so
# a pure update-merge compares equal. Hashing raw diff bytes was strictly
# worse: it failed the gate on line-number shifts alone.
set -uo pipefail

base=${1:?usage: same-change.sh <base-ref> <reviewed-sha> <head-sha>}
reviewed=${2:?}
head=${3:?}

# Fail closed on anything at all: this function's answer can only ever RELAX
# a block, so an error must mean "no".
command -v git >/dev/null 2>&1 || exit 1

patch_id() {
  local sha=$1 resolved merge_base id
  resolved=$(git rev-parse --verify -q "${sha}^{commit}") || return 1
  merge_base=$(git merge-base "$base" "$resolved" 2>/dev/null) || return 1
  # --verbatim, not --stable. Both ignore diff ordering and line numbers,
  # which is the whole point -- the merge base moves, so hunks move with it.
  # But --stable also strips WHITESPACE before hashing, and this repo decides
  # meaning by indentation in two languages: a merge that moved a Python
  # statement out of its `if` block, or a YAML step under a different key,
  # hashed identical to one that did not, and the earlier review was carried
  # onto code that no longer meant the same thing. --verbatim keeps the
  # whitespace and still normalises everything that legitimately moves.
  # pipefail (set above) makes a failing patch-id fail this substitution.
  id=$(git diff "$merge_base" "$resolved" 2>/dev/null | git patch-id --verbatim 2>/dev/null | awk '{print $1}') || return 1
  # An empty diff yields no patch-id on either side -- handled by the caller,
  # since two empty changes are legitimately the same change. A non-empty
  # diff with no patch-id means patch-id failed: fail closed.
  if [ -z "$id" ]; then
    git diff --quiet "$merge_base" "$resolved" 2>/dev/null || return 1
  fi
  printf '%s' "$id"
}

git rev-parse --verify -q "${base}^{commit}" >/dev/null || exit 1

a=$(patch_id "$reviewed") || exit 1
b=$(patch_id "$head") || exit 1
[ "$a" = "$b" ] || exit 1
exit 0
