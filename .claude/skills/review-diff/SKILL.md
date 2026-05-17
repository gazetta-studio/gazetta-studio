---
name: review-diff
description: General code-review baseline — reviews a diff for bugs, null/undef handling, race conditions, CLAUDE.md violations, and basic style issues. Always fires (the unconditional baseline angle of the review-orchestrator family). Use when the diff is small enough to review as-a-whole; specialized angles (review-security, review-tests, etc.) cover their own surfaces.
allowed-tools: Bash Read Grep Glob
argument-hint: [--base <ref>] [--pr <N>]
---

# Review-diff — Phase 2 baseline angle

The always-fires baseline angle in the review-orchestrator family. Catches the dominant class of issues that don't need a specialized lens: logic bugs, mishandled error paths, dead code, CLAUDE.md violations, basic style problems on the changed lines.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design + skill family. See [ADR-0013](../../../docs/adr/0013-code-review-two-phase-model.md) for the Phase 1 / Phase 2 split.

## What this angle owns

| Owned here | Owned by another angle |
|---|---|
| Logic bugs (off-by-one, wrong operator, swapped args) | — |
| Null/undef handling, optional chaining misuse | — |
| Race conditions in synchronous code | — |
| Dead code, unreachable branches | — |
| CLAUDE.md violations on the changed lines | — |
| Basic style: import sorting, function-keyword preference, formatting | — |
| Comment accuracy → `review-comments` | |
| Type design / invariants → `review-types` | |
| Test quality / TDD / tautology → `review-tests` | |
| SSRF / capability gates / sanitization → `review-security` | |
| Foundational-dimension fit → `review-architecture` | |

When uncertain whether a finding belongs here or another angle: prefer the more specialized angle. `review-diff` is the fallback; specialized angles win in their domain.

## Reads (always)

- [`CLAUDE.md`](../../../CLAUDE.md) — project rules, build/test conventions, "doing tasks" guidance
- [`.claude/rules/team-preferences.md`](../../rules/team-preferences.md) — numbered preferences (rule 15/18 SOLID, rule 19 Boy Scout, etc.)

Read these once per invocation; don't re-read between findings.

## Reads (on demand, max 1 per invocation)

Match the diff's path patterns; read at most ONE additional doc when relevant:

| When the diff touches… | Read |
|---|---|
| Files under `apps/admin/src/client/` (Vue) | Look for PrimeVue conventions; check [`.claude/rules/css-theming.md`](../../rules/css-theming.md) only if styles change |
| `bots/` | Skim [`bots/README.md`](../../../bots/README.md) "Producer vs consumer" |
| `packages/gazetta/src/cli/` | No extra reading — CLAUDE.md "Build & Test" covers it |

If the diff touches a foundational area (audit / validation / hooks / auth / review / scheduling / soft-delete), DON'T read those design docs here — that's `review-architecture`'s job. Stay in baseline scope.

## Severity assignment

Per the locked severity model in [`design-code-review.md`](../../rules/design-code-review.md):

| Severity | Trigger | Confidence floor |
|---|---|---|
| **CRITICAL** | Contract-break, security issue, data loss; bug that will affect users | ≥ 90 |
| **IMPORTANT** | Logic bug with confined blast radius; CLAUDE.md violation; missing error path | ≥ 80 |
| **NIT** | Style preference, minor formatting, optional improvement | ≥ 80 |

Drop anything with `confidence < 80`. Aggressive filtering keeps false-positive rate low (per the [Anthropic GA Code Review benchmark](https://claude.com/blog/code-review) — <1% FP rate at scale).

## Process

### 1. Read the diff payload

The orchestrator provides:
- `mode: diff`
- `base: <ref>` (e.g., `main` or `HEAD`)
- `files: [...]` (each with `path`, `status`, `content`)
- `metadata.commit_log` when available

If invoked directly (not from the orchestrator), call `git diff --name-status $BASE` and then `git diff $BASE -- <path>` per file. Limit to the first 50 files.

### 2. Walk each changed file

For each file:

1. Read the diff content
2. Look for the issues listed in "What this angle owns"
3. Form candidate findings; rate confidence honestly:
   - 90+: I'm sure this is wrong; a competent reviewer would also flag it
   - 80-89: Likely an issue but context-dependent; explain in the message
   - <80: Drop. The signal isn't strong enough to emit.

### 3. Cite the rule

Every finding has a `rule` field. For this angle the citation is typically:
- `CLAUDE.md` — when the issue is a documented project rule
- `team-preferences.md#<rule-number>` — when the issue violates a numbered preference
- `<file-name>:<line>` — when the issue is purely about the code (no doc to cite)

When the issue has no documented rule and is just "this is a bug" — that's fine, set `rule` to the file:line where the bug originates, and the `message` carries the description.

### 4. Emit prose + findings fence

Above the fence, emit:
- `> Decision: which files were reviewed`
- `> Decision: which patterns I checked for (briefly — don't enumerate every possible bug class)`
- `> Decision: which findings made the ≥80 cut, which were dropped and why`

The fence is the structured output:

````
```findings
{"severity":"CRITICAL","file":"packages/gazetta/src/foo.ts","line":47,"confidence":92,"category":"correctness","rule":"CLAUDE.md","message":"...","suggestion":"..."}
{"severity":"IMPORTANT","file":"packages/gazetta/src/foo.ts","line":89,"confidence":85,"category":"correctness","rule":"team-preferences.md#15","message":"...","suggestion":"..."}
```
````

When NO findings ≥ 80 confidence: emit an empty fence with prose explaining what was checked. Per the locked empty-fence semantics:

````
> Decision: walked 3 files (foo.ts, bar.ts, baz.ts); looked for null-handling, off-by-one, missing error paths, CLAUDE.md violations. No concerns ≥ 80 confidence.

```findings
```
````

Empty fence + prose is a definite outcome, not silence.

## Anti-patterns this angle catches (illustrative)

- **Off-by-one**: `for (let i = 0; i <= arr.length; i++)` or `arr[arr.length]`
- **Missing await**: an async function call without `await`, when the result is needed downstream
- **Swapped args**: `combine(left, right)` called as `combine(right, left)` based on context
- **Dead code**: a branch that's now unreachable after a refactor
- **Mishandled rejection**: `Promise.reject(err)` without a catch / async function with no error path
- **Logical operator confusion**: `a || b && c` where the precedence is wrong
- **Unintended mutation**: pushing to a shared array, mutating a frozen-by-convention object
- **CLAUDE.md violations**: comments on obvious code; `console.log` left in; new files when editing existing would suffice
- **Rule 15/18 violations**: new abstraction layer for one caller; inheritance where composition was already established

These are illustrative, not exhaustive. Use judgment; the confidence threshold filters noise.

## What NOT to flag

- **Type design issues** (`review-types`'s job)
- **Test isolation, TDD ordering, tautology** (`review-tests`'s job — including static checks)
- **Security**: SSRF, capability gates, sanitization (`review-security`'s job)
- **Foundational-dimension fit**: validator phase, hook lifecycle, audit shape (`review-architecture`'s job)
- **Style issues that a formatter would catch** (Biome runs in CI per [`team-preferences.md#30`](../../rules/team-preferences.md))
- **Things the user could fix with `tsc --noEmit`** (build verification, not review)
- **Architectural debates** about what the code SHOULD look like in some ideal form — review is about what changed in this diff, not redesign

## When to invoke

This angle is **always invoked** by the orchestrator (it's the unconditional baseline). Direct invocation (`/review-diff`) is also supported for focused review.

## Stop conditions

- Stop if the diff is empty (no changed files): emit empty fence + prose
- Stop if you've emitted findings for all files in the diff
- Stop if no finding makes the ≥80 confidence cut: emit empty fence + prose

## Decision-log convention

Per [`bots/README.md`](../../../bots/README.md) decision-log convention, emit `> Decision: ...` notes inline. Don't narrate every tool call — call out load-bearing choices (e.g., "kept the finding at confidence 85 because the bug is context-dependent — explained in the message" or "dropped a candidate finding at confidence 75 because the issue is purely stylistic and rule 19 Boy Scout doesn't apply to unrelated files").
