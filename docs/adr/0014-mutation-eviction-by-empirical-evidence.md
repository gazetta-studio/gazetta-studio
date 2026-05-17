# Mutation-area-picker evicts modules by empirical evidence, not by time

> Full architectural model + foundational checks live in [`.claude/rules/design-mutation-area-picker.md`](../../.claude/rules/design-mutation-area-picker.md). This ADR captures the load-bearing eviction-trigger choice; the design doc captures everything else.

The mutation-area-picker bot evicts a scoped module from `stryker.config.json`'s `mutate` glob ONLY when two empirical conditions both hold: kill ratio above 0.85 sustained across the last 4 weekly Stryker runs, AND more than 70% of mutation-watcher issues for that module are closed-merged within the last 90 days.

Modules are NOT evicted by time alone. A module that's been in the mutate glob for 6 months with kill ratio 0.5 stays in scope.

We picked this two-condition empirical trigger over time-bound eviction because time alone measures effort spent, not test quality achieved. A long-mutated module with low kill ratio means tests are still weak — graduating it would explicitly drop coverage where coverage is most needed. The bot's job is to manage the portfolio of mutation testing toward effectiveness; time-bound rotation is fairness logic that doesn't compose with that goal.

We picked kill-ratio AND fix-rate combined over either alone because each signal in isolation can mislead. Kill ratio alone can be high because nobody added new code recently (stale module): mutants happen to live in already-covered branches. Fix-rate alone tracks human responsiveness, not test quality — a module where humans diligently close every mutation-watcher issue might still have weak underlying tests. Combined, they triangulate: high kill ratio (the tests are rigorous) AND high fix-rate (humans are actively maintaining them) means mutation testing has done its job and budget should rotate elsewhere.

The thresholds (0.85 kill ratio, 70% fix rate, 4-week sustainment window, 90-day fix-rate window) are env-overridable defaults. They're initial guesses informed by Stryker's documented "high" threshold (80%) plus headroom for variance — but the design treats these as calibratable rather than locked. After 6-12 months of bot operation, accumulated data on which evictions correctly graduated modules vs. which left coverage degraded will let us re-anchor the defaults.

## Consequences

A long-mutated module with low kill ratio stays in the portfolio indefinitely. This is intentional: low kill ratio is the signal that tests need work, and removing the module would hide the signal. The corollary is that humans wanting to retire a module must improve its tests first (raising kill ratio), then the bot will rotate it out. Mutation testing becomes a forcing function for test quality.

Bootstrap means the bot cannot evict during its first 4 weeks of operation — the eviction rule requires 4 weekly Stryker runs of history. During bootstrap, the bot can only ADD or NOOP. After week 4, full decision tree fires.

Operators wanting time-bound rotation (e.g. for fairness or to ensure all modules get cycles) can implement it by manually removing modules from the glob; the bot won't propose adding them back unless their inclusion score qualifies. The bot's design accepts manual operator intervention via the standard config-PR pathway — operators commit to `stryker.config.json` directly when needed.

If empirical-only eviction proves too conservative (modules accumulate in the portfolio faster than they graduate), the future direction is to lower thresholds rather than introduce time-bound rotation. Time-bound rotation would re-couple effort-spent to graduation, which is exactly the coupling this ADR rejects.

When kill ratio briefly dips below 0.85 (e.g. someone adds new code; mutation testing finds new gaps), the sustained-across-4-weeks rule prevents thrashing — a module's graduation only completes when the high kill ratio holds across a full month of Stryker runs.

The fix-rate signal depends on mutation-watcher continuing to file issues and humans continuing to close them. If mutation-watcher's filing stalls (e.g. the time-bound suppression from PR #395 mis-fires), fix-rate sinks artificially and no module can graduate. This is a soft coupling: graduation pauses but doesn't break. Recovery is restoring mutation-watcher's filing.
