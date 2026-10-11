<!-- Describe the change and, more usefully, why. -->

## Review decisions

CI fails unless this description carries exactly one line for each of the two
tokens below. Nobody approves PRs here, so this is the only moment either
decision gets made deliberately rather than by default.

Keep one line from each pair, delete the other:

Code-Review: ran
Code-Review: skipped — <say why in a few words>

Simplify: ran
Simplify: skipped — <say why in a few words>

<!--
"ran" means the command was run against this branch and its findings were
addressed or explicitly dismissed.

/code-review looks for correctness bugs. /simplify looks for reuse,
duplication, wasted work and fixes applied at the wrong altitude. They answer
different questions, which is why they are decided separately.

Skipping either is a legitimate choice — a typo fix, a revert, a docs tweak.
Writing the reason down is the point; it takes five seconds and it is the
difference between a decision and an omission. See CLAUDE.md for what usually
warrants each.
-->
