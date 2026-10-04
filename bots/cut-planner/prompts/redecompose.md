# cut-planner — split a cut that refinement could not land

Cut #$CUT_NUMBER has been refined twice and still could not be landed. The
remaining lever is the breakdown itself: split it into smaller cuts that can
each land independently.

Splitting is the fallback, not the default, and it is only right when the cut
genuinely bundles separable work. If the reviewer's objections are about the
approach rather than the size, answer `design-objection` instead.

$CONTEXT

## The cut as it stands

**#$CUT_NUMBER — $CUT_TITLE**

$CUT_BODY

## The reviewer's latest verdict

$REVIEWER_NOTE

## What to do

Answer with ONE of:

- `{"action": "redecompose", "first": <cut spec>, "remaining": ["one-line description of each further cut", "..."], "summary": "why it splits this way", "state": "<new State section>"}`
  — `first` is filed now; `remaining` is recorded and filed one at a time
  later, so `remaining` must name at least one more cut. `state` replaces the
  planner's `## State` and must list the remaining pieces as next.
- `{"action": "design-objection", "reason": "..."}`
- `{"action": "needs-input", "question": "...", "options": ["...", "..."], "recommendation": "..."}`

$CONTRACT
