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

Answer with ONE of these, written out in full (cut-spec fields are defined
in the contract below):

**Split it** — `first` is filed now; `remaining` is recorded and filed one
at a time later, so it must name at least one more cut. `state` replaces
the planner's `## State` and must list the remaining pieces as next. Write
`#NEW` for the first piece; it has no number until it is filed:

```
{"action": "redecompose", "first": {"title": "...", "spec": "...", "acceptance": ["..."], "tests": ["..."], "solid": null, "lockIndices": [0], "files": ["path/to/file.ts"]}, "remaining": ["one-line description of each further cut"], "summary": "why it splits this way", "state": "In flight: #NEW — <first piece title>\nNext: ..."}
```

**The objections are about the approach, not the size:**

```
{"action": "design-objection", "reason": "..."}
```

**Ask for a decision** the planner issue does not lock:

```
{"action": "needs-input", "question": "...", "options": ["...", "..."], "recommendation": "..."}
```

$CONTRACT
