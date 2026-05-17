# Mutation-area-picker

Autonomous bot that decides which source modules belong in `stryker.config.json`'s `mutate` glob. Runs weekly; opens a PR only when its judgment says the scope should change.

The portfolio of mutated modules is bounded by nightly Stryker runtime (currently ~1h 45m, hard ceiling 3h). The bot CAN'T mutate everything — it has to choose, and the choice has been a human decision until now.

**Status**: design pass complete (2026-05-17). Implementation deferred until the existing v2 reviewer-loop work (PR #395 + earlier bot infrastructure) has stabilised in production for one full week.

**Companion docs**:
- [`.claude/rules/testing-plan.md`](testing-plan.md) — where the human-curated next-list lived (replaced by this bot)
- [`docs/adr/0014-mutation-eviction-by-empirical-evidence.md`](../../docs/adr/0014-mutation-eviction-by-empirical-evidence.md) — the load-bearing decision to evict modules empirically (kill-ratio + fix-rate), not by time
- [`docs/adr/0011-bot-memory-cache-persistence.md`](../../docs/adr/0011-bot-memory-cache-persistence.md) — cache-based persistence pattern this bot inherits
- [`bots/README.md`](../../bots/README.md) — bot ecosystem context (memory, generator-critic, concurrency)
- [`packages/gazetta/stryker.config.json`](../../packages/gazetta/stryker.config.json) — the `mutate` glob the bot owns

## Why this is a bot, not a script

Three things make autonomous selection meaningfully harder than the current human discipline:

- **Five cross-references no human computes by hand** — AI-pairing density, test/source ratio, churn, flake correlation, bug-fix correlation. Together they predict where surviving mutants will accumulate; separately each is one signal among many.
- **Portfolio management under a runtime budget** — adding a module without freeing one costs nightly minutes. As coverage matures, the question shifts from "add" to "swap" to "remove." Humans don't track per-module saturation.
- **Weekly cadence** — every cron sees fresh Stryker data; humans don't react that frequently.

The bot replaces `testing-plan.md`'s human-curated next-list. After ship, that list is dead weight.

## Scope

**In v1:**
- Weekly cron trigger after the weekly Stryker run
- Five-signal weighted inclusion score for un-mutated modules
- Composite eviction score (kill-ratio sustained + fix-rate of past issues) for scoped modules
- Decision tree: ADD / SWAP / REMOVE / NOOP per run
- One draft PR per acting week (or zero)
- Per-bot durable memory (skip-list + reviewer-log) per the project's bot memory pattern
- Module-level granularity (one row per src file, NOT per-glob)
- Bootstrap discipline: first 4 runs do not evict (need 4-week kill-ratio history)
- Runtime budget env-overridable (`MUTATION_BUDGET_MINUTES`, default 105)

**Out of v1 (explicit):**
- A reviewer agent (Agent B). Mutation testing IS the empirical reviewer — Stryker's next run tells us whether the pick was right. Adding a reviewer here would be cargo-cult pattern-matching of dead-code-watcher's loop.
- Cross-bot signal sharing (e.g., reading mutation-watcher's skip-list). Different domains; keep memory separate.
- Tactical per-run file prioritisation. Locked as a future second bot (`mutation-target-prioritiser`); designed separately.
- Time-bound eviction (graduating modules just because they've been in glob long). Time without kill-ratio evidence would graduate weak coverage; rejected.

**Non-goals:**
- Beating human judgment on the first week. Initial heuristic weights are guesses; calibration happens over 4-6 PRs as data accumulates.
- Mutating everything. Permanent constraint: portfolio size is bounded by runtime budget; the bot manages the portfolio, doesn't eliminate the boundary.

## Decision model

### The portfolio

The bot maintains a set of modules in `stryker.config.json`'s `mutate` glob, bounded by runtime budget. Every cron, the bot evaluates:

```
ADD     when: budget headroom exists for the top un-mutated candidate
SWAP    when: at budget AND top un-mutated outranks lowest scoped (by eviction score)
REMOVE  when: at budget AND a scoped module is eviction-ripe AND no un-mutated candidate clears the SWAP bar
NOOP    otherwise — exit silently, no PR
```

The bot never proposes ADD beyond budget. SWAP and REMOVE keep the portfolio sustainable.

### Inclusion score (for un-mutated modules)

Composite weighted sum across five signals:

| Signal | Weight | Source |
|---|---|---|
| AI-pairing density | 0.30 | `git log --grep "Co-Authored-By: Claude" --since=90d --name-only \| sort \| uniq -c` per module path |
| Test/source LOC ratio, inverse | 0.25 | `find packages/gazetta/tests -name "*<basename>*" \| xargs wc -l` vs `wc -l src/<mod>` |
| Recent churn | 0.20 | `git log --since=90d --name-only \| sort \| uniq -c` per module path |
| Flake correlation | 0.15 | `gh issue list --label flake --state all` — does module path appear in title or body? |
| Bug-fix correlation | 0.10 | `gh pr list --search "fix:" --search "created:>2026-04-17"` — does module path appear in PR diff? |

Each signal normalised to [0, 1] across the candidate set, then weighted. Final score in [0, 1].

**Why these weights:** initial guesses informed by `team-preferences.md` rule 31 (AI-paired code most likely to have tautological tests) and the asymmetry between empirical signals (flake, bug-fix) and structural signals (LOC ratio, churn). Concrete weights are env-overridable so we can adjust without a code change. After 4-6 PRs we'll have data on which signals correlate with surviving-mutant counts and recalibrate.

### Eviction score (for scoped modules)

Composite triggering condition:

```
evict = (killRatio > 0.85 sustained across last 4 weekly Stryker runs)
     AND (>70% of mutation-watcher issues for this module are closed-merged in last 90 days)
```

Both thresholds env-overridable (`EVICTION_KILL_RATIO`, `EVICTION_FIX_RATE`).

**Why two conditions, not one:**

- Kill ratio alone could be high because nobody added new code to mutate (stale module). Doesn't catch "tests are weak but mutants happen to be in covered branches."
- Fix-rate alone tracks human responsiveness, not test quality. Could be high while underlying tests stay weak.
- Together they triangulate: high kill ratio with humans actively fixing → mutation testing achieved its purpose.

**Why not time-bound:** time without kill-ratio evidence graduates weak coverage. A module mutated for 6 months with kill ratio 0.5 should STAY until tests improve, not rotate out.

### Bootstrap

First 4 weekly runs after deployment: bot does NOT evict. Reason: the eviction rule requires "kill-ratio sustained across last 4 weekly Stryker runs" — that history doesn't exist for week 1, 2, 3. Bot can only ADD or NOOP during bootstrap.

After week 4, full decision tree fires.

Today's mutate glob (`src/history-*.ts`, `src/publish*.ts`, `src/admin-api/**/*.ts`, `src/alt/route-handler.ts`, `src/hooks/registry.ts`) is treated as "earned-in" — these modules are scoped because humans deliberated; the bot inherits them without re-justifying.

### Runtime budget

Default `MUTATION_BUDGET_MINUTES=105` (= 1h 45m current). Hard ceiling 180 min (workflow timeout).

Bot estimates per-module cost from Stryker's per-file timing reports (already in Stryker's JSON output). For un-mutated modules, the bot uses a conservative estimate: `(lines mutated) × 0.1 seconds per mutant × estimated mutant density`. Stryker reports mutant counts per file once mutation runs.

When budget is exceeded by sum-of-scoped: the bot SHOULD eventually propose REMOVE. In practice this only happens if humans manually expand the glob beyond the budget; bot's own ADDs respect the cap.

## Decision criteria detail

**ADD fires when:**
- Top un-mutated candidate's inclusion score ≥ `INCLUSION_THRESHOLD` (default 0.4)
- Estimated cost of adding it + sum-of-scoped ≤ budget

**SWAP fires when:**
- At budget (no ADD possible)
- Top un-mutated inclusion score > best eviction score on scoped set
- The scoped module being evicted has eviction score ≥ `EVICTION_THRESHOLD` (default 0.7)

**REMOVE fires when:**
- At budget (no ADD possible)
- A scoped module has eviction score ≥ `EVICTION_THRESHOLD`
- No un-mutated candidate clears the SWAP bar (i.e., nothing better to replace it with)

**NOOP fires when:**
- Below ADD threshold AND below SWAP/REMOVE thresholds
- Exit silently, no PR opened. Run summary banner shows "No scope change justified this week."

## Memory

Per the project's "bots should have separate memory" rule (ADR-0011 + the v2 bot infrastructure):

- **`bots/mutation-area-picker/skip-list.json`** — modules to never propose. Two entry types:
  - **never-mutate** — generated code, third-party shims, files where mutation testing is meaningless
  - **maintainer-rejected** — bot proposed it; maintainer closed the PR with a reason
- **`bots/mutation-area-picker/reviewer-log.jsonl`** — every decision logged (ADD/SWAP/REMOVE/NOOP + reasoning). Future compactor input.
- **`bots/mutation-area-picker/lessons-learned.md`** — distilled patterns from a future compactor (e.g., "AI-pairing density correlates poorly with surviving-mutant count on this codebase; lowered to 0.15"). Empty placeholder in v1.

Persisted via `actions/cache@v4` keyed `mutation-area-picker-reviewer-log-v1` (ADR-0011 pattern). Skip-list and lessons-learned are committed to repo via PR.

**No compactor in v1 — deliberately deferred.** Unlike dead-code-watcher
and fix-bot (which produce 100+ decisions per cron and accumulate
skip-list entries quickly), mutation-area-picker produces ~1 decision per
week. Skip-list growth is rate-limited to ~1-3 maintainer rejections per
year at steady state; reviewer-log fills the 200-entry cache ceiling
after ~4 years. Compactor value depends on signal volume; at this
cadence, the volume isn't there.

The portfolio itself self-compacts via SWAP/REMOVE actions (each cron's
empirical eviction is continuous compaction of the working set, not a
memory artifact). What a compactor WOULD do — distilling cross-decision
patterns into prose — has too thin a signal to justify the ~150 LOC + a
monthly `bots-compact.yml` job slot until the bot has been running for
6+ months.

**Triggers to revisit compactor design** — any one:
- Skip-list grows past 10 entries with visible glob-compactable patterns
- Reviewer-log entries accumulate past 200 (cache ceiling) and we want
  bounded cache via the `pruneReviewerLog` helper
- Calibration drift becomes obvious — bot consistently picks weak
  candidates because heuristic weights are wrong; lessons-learned would
  surface the recurring pattern

## PR shape

**Draft PR.** Title:
- `chore(mutation): add <X> to stryker mutate glob`
- `chore(mutation): swap <Y> for <X> (mature: <Y> kill ratio Z%)`
- `chore(mutation): remove <Y> from stryker mutate glob (mature: kill ratio Z%)`

**Body sections:**
1. **Decision** — which action (ADD / SWAP / REMOVE) and what fired the rule
2. **Top 3 inclusion candidates** — module + scores per signal + composite. Maintainer sanity-checks weighting in every PR.
3. **Eviction scores for all scoped modules** — composite + breakdown. Surfaces "X is graduating soon" before the actual eviction PR.
4. **Estimated runtime impact** — current portfolio cost + delta from this PR
5. **Files changed** — `stryker.config.json` + `testing-plan.md` mutation-scope section

**Outcome tag** at body end for the feedback loop: `<!-- mutation-area-picker: action=ADD module=hooks/registry.ts run=$RUN_ID -->`

## Failure modes + recovery

| Failure | Detection | Recovery |
|---|---|---|
| Wrong-pick module (low actual value) | Maintainer closes PR with reason | Bot reads close reason via past-PR feedback loop; adds to skip-list. Same pattern as dead-code-watcher. |
| Weights miscalibrated (consistently bad picks) | Pattern across reviewer-log entries | Manual recalibration by reading the cached reviewer-log; operator adjusts env var weights. (Future compactor surfaces patterns automatically when it ships — triggers above.) |
| Bot proposes ADD beyond budget | Wouldn't — bot estimates before proposing | N/A by construction |
| Glob already at budget, no eviction-ripe module | NOOP fires; bot exits silently | Normal operation — wait for kill ratios to mature |
| Bootstrap period bug | First 4 runs ADD only; eviction history accumulates | Document explicitly; bot's banner shows "bootstrap: week N/4" |

## Foundational checks

How this bot composes with each of the 13 foundational dimensions + multi-instance discipline:

- **Multi-instance check.** Bot runs as singleton workflow per `concurrency: group: mutation-area-picker` (ADR-0011 pattern). No cross-workflow racing on the cached reviewer-log.
- **Scale check.** Per-cron cost: 5 signal queries × ~50 candidate modules = 250 light operations + 1 Claude invocation. Well under the per-cron 50-min budget. The cron runtime is dominated by the gh API calls, not the Claude call.
- **Locale / Theme / RTL checks.** Bot doesn't render UI; N/A.
- **Auth + RBAC.** Bot uses `GH_TOKEN` (GitHub Actions default) for repo writes. Same trust model as other producer bots.
- **Audit.** Every decision logged to `reviewer-log.jsonl`. PR creation creates GitHub audit trail. No `action: 'mutation-scope-change'` audit-log event needed — bot output IS the audit trail.
- **Review workflow.** N/A (bot's PRs go through standard human review).
- **Hook check.** Bot doesn't fire hooks. Its output is a config-file PR.
- **Render / Validation / Plugin / Cache / Offline / Collaboration.** N/A (infrastructure bot, not user-facing surface).

## UX check

Per `team-preferences.md` rule 23 — "Don't Make Me Think":

- **Absence-as-state.** Bot exits silently (no PR) on NOOP weeks. Maintainer's inbox stays clean unless action is justified.
- **Universal language in PR body.** "ADD / SWAP / REMOVE / NOOP" — verbs the maintainer can scan in one glance.
- **No help tooltips.** PR body's "Top 3 candidates" section IS the explanation. If a maintainer can't tell why the bot picked X over Y from the body, the body is wrong; fix it rather than adding a comment thread.
- **Same affordance regardless of state.** PR body has the same shape whether bot ADDs, SWAPs, or REMOVEs. Maintainer's review pattern is uniform.

## Migration

`testing-plan.md`'s "Mutation scope expansion (next)" section's ordered next-list gets replaced with a one-liner pointing at this design doc. The list represents thinking we've already absorbed into the inclusion-score heuristic (smallest-first → factored into test/source LOC ratio; AI-heavy → factored into AI-pairing density).

No code migration. The bot ships fresh; first run after deployment treats existing glob as earned-in.

## Open implementation questions

1. **Module granularity definition.** `src/admin-api/**/*.ts` in current glob covers ~30 files. The bot needs to score per-file, not per-glob. Migration: the bootstrap step normalises today's glob into per-file entries; bot operates per-file going forward.
2. **Stryker per-file timing report parsing.** Stryker emits per-file timing in HTML; bot reads via mutation-watcher's existing `mutation-report-staging/` artifact. Confirm the JSON output format includes timings (it should — Stryker's `--reporters json` shape).
3. **Initial weights as env vars vs constants.** Env vars give operator override without code change; constants live with the code. Recommend env vars for thresholds (`INCLUSION_THRESHOLD`, `EVICTION_KILL_RATIO`, etc.) but constants for the five signal weights (those need code change + PR review since they're heuristic-load-bearing).
4. **Bootstrap cliff.** Week 4 → week 5 transition: bot suddenly enables eviction. Soft-launch by lowering eviction threshold for first month? Or hard cutover? Defaulting to hard cutover (simpler) unless the first month's data shows incorrect graduations.

## Future directions

- **Mutation-target-prioritiser** — tactical sibling bot. Re-ranks the "top-N actionable files" mutation-watcher investigates each cron. Ships when actionable-file set grows large enough that count-only ranking misses high-value targets.
- **Weight auto-tuning** — currently weights are operator-set via env. Could be auto-tuned from "did the picks have high surviving-mutant counts after testing?" feedback. Earned when 12+ months of data accumulates.
- **Cross-bot signal** — read mutation-watcher's skip-list to suppress modules with recent attempts. Currently rejected (bots should have separate memory); could revisit if signal proves valuable.
- **Eviction budget reuse** — when a module evicts, its freed runtime budget should pool for the next ADD. Bot tracks this implicitly via the budget recompute on every cron.
