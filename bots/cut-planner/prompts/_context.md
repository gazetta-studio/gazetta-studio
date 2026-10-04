## Your input: the planner issue (#$PLANNER_ISSUE)

This is your ONLY source of intent. Do not open `$DESIGN_PATH` or any other
design doc: the maintainer has already transcribed everything you may use into
this issue, and a cut that depends on something not written here is a cut that
smuggles in an unlocked decision.

You MAY read source code (Read / Grep / Glob) to name the concrete files a cut
should change and the test files it should add. Naming a file is not a design
decision; choosing between two architectures is.

**Feature:** `$FEATURE`

### Suggested plan (advisory — you may deviate, but must say why)

$SUGGESTED_PLAN

### State (what has landed, what is in flight)

$STATE

### Locked decisions (select by index; never paraphrase, never add)

$LOCKS

### Lessons from previous features

Distilled monthly from how earlier cuts went. Guidance, not locks: they
never override this planner issue's locked decisions.

$LESSONS
