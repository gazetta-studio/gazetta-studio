## Output contract

Think in prose first if it helps. Then end your response with exactly ONE
fenced block tagged `cut-plan` containing a single JSON object. Only the last
such block is read; anything malformed is treated as a failure and sent to a
human, so be exact. The opening fence must be exactly ```` ```cut-plan ```` —
not ```` ```json ````:

````
```cut-plan
{"action": "...", ...}
```
````

A **cut spec** object has these fields:

```
{
  "title":       "short imperative title, no feature prefix",
  "spec":        "what to build and where — functional requirement plus the technical suggestions that follow from the locked decisions",
  "acceptance":  ["testable outcome", "..."],            // at least one
  "tests":       ["path/to/file.test.ts — behaviour it pins", "..."],  // at least one
  "solid":       "which SOLID lens is load-bearing and why" | null,   // null for pure-data or docs cuts
  "lockIndices": [0, 2],                                   // indices into the Locked decisions list; [] if none apply
  "files":       ["path/to/file.ts", "..."]                // files you expect the cut to EDIT
}
```

Rules that are checked mechanically:

- `lockIndices` must be valid indices into the numbered list above. The lock
  TEXT is copied from the planner issue by index, so you cannot reword it.
- `files` must list every file you expect the cut to edit. If any is under
  `.github/workflows/`, say so: such a cut is filed for a human, because the
  bots cannot push workflow files.
- A **design decision the planner issue does not lock is not yours to make.**
  If the next cut cannot be specified without one, answer `needs-input`
  instead — with at least two options and a recommendation.
