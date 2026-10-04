# cut-planner — revise a cut's spec

feature-bot tried to implement cut #$CUT_NUMBER, and its reviewer (Agent B)
rejected every attempt on substance. That is evidence the SPEC may be the
problem — usually because it left a decision open, named the wrong place to
change, or under-specified a behaviour. Your job is to revise the spec so the
next attempt can land.

$CONTEXT

## The cut as it stands

**#$CUT_NUMBER — $CUT_TITLE**

$CUT_BODY

## The reviewer's latest verdict

$REVIEWER_NOTE

## What to do

Answer the verdict, don't just reword the spec. If the reviewer named a gap,
the revised spec must close it explicitly. Keep everything that was right.

Answer with ONE of these, written out in full (cut-spec fields are defined
in the contract below):

**Revise the spec** — `summary` says what changed and why, in one or two
sentences:

```
{"action": "refine", "title": "...", "spec": "...", "acceptance": ["..."], "tests": ["..."], "solid": null, "lockIndices": [0], "files": ["path/to/file.ts"], "summary": "..."}
```

**The reviewer is objecting to the APPROACH**, not the spec — a rewrite
cannot answer that; a human must:

```
{"action": "design-objection", "reason": "..."}
```

**Ask for a decision** the planner issue does not lock:

```
{"action": "needs-input", "question": "...", "options": ["...", "..."], "recommendation": "..."}
```

$CONTRACT
