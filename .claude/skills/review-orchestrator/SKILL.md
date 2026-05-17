---
name: review-orchestrator
description: Run the full code-review skill family on a diff — dispatches angle skills (review-diff / review-architecture / review-security / review-tests / review-types / review-comments) in parallel based on what the diff touches, then aggregates findings. Use for pre-commit / pre-PR review, PR-comment review, fix-bot reviewer verification, or autonomous review-bot's Agent B step.
allowed-tools: Bash Read Grep Glob Agent
argument-hint: [--base <ref>] [--pr <N>]
---

# Review orchestrator — Phase 2 evaluation

Fan out a diff to the appropriate **angle skills**, then aggregate their findings into one structured report. The skill IS the orchestrator: it picks angles via deterministic dispatch (TS) and spawns each as a parallel sub-agent (Agent tool).

This is Phase 2 — Evaluation. For Phase 1 — Discovery (find candidate improvements in an area without a diff yet), use `audit-area` instead.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design. See [ADR-0012](../../../docs/adr/0012-skill-three-invocation-modes.md) for the three-invocation-modes Skill contract and [ADR-0013](../../../docs/adr/0013-code-review-two-phase-model.md) for the Discovery / Evaluation phase split.

## Inputs

Three diff sources, picked per invocation:

| Flag | Diff |
|---|---|
| _none_ | `git diff HEAD` — uncommitted changes (default; matches the local pre-commit use case) |
| `--base <ref>` | `git diff <ref>` — typically `--base main` to review the whole branch |
| `--pr <N>` | `gh pr diff <N>` — review an open PR |

## Process

### 1. Dispatch — which angles fire?

Invoke `dispatch.sh` (wraps `bots/_lib/review-dispatch.ts`) against the current diff:

```bash
./node_modules/.bin/tsx bots/_lib/review-dispatch.ts $DISPATCH_ARGS
```

It prints one angle name per line on stdout (e.g. `review-diff\nreview-tests\nreview-security`).

**The dispatch table** (documented here; implemented in `bots/_lib/review-dispatch.ts`; tested in `bots/_lib/tests/review-dispatch.test.ts`):

| Diff includes… | Always | Conditionally |
|---|---|---|
| Any code change | `review-diff` | — |
| `tests/`, `*.test.ts`, `*.spec.ts` | + `review-tests` | — |
| `z.object(...)` / `interface X` / `type X =` / `/types.ts` / `/schemas/` | + `review-types` | — |
| `packages/gazetta/src/{audit,validation,hooks,auth,review,scheduling,soft-delete}/`, `.claude/rules/design-*.md`, `docs/adr/` | + `review-architecture` | — |
| `admin-api/`, `providers/`, `*sanitize*`, `*capability*`, `*auth*`, `package.json`, `fetch(`, `child_process`, `exec(` | + `review-security` | — |
| Comment-only changes | + `review-comments` | — |

### 2. Fan out — invoke angles in parallel

For each angle name `dispatch.sh` emits, spawn it as a sub-agent via the `Agent` tool in a SINGLE message with multiple Agent calls. This is the parallel-fan-out pattern (per [Anthropic's GA Code Review architecture](https://claude.com/blog/code-review)).

Each sub-agent invocation passes the diff payload as input.

### 3. Parse — each angle's findings fence

Each angle skill emits a structured response: prose reasoning above, then a JSONL `findings` fence. The fence may be empty (no findings) but always present. Parse each sub-agent's reply by extracting the content between ` ```findings ` and ` ``` `.

Expected per-finding schema (eight fields):

```json
{
  "severity": "CRITICAL" | "IMPORTANT" | "NIT",
  "file": "<repo-relative path>",
  "line": <number>,
  "confidence": <0-100>,
  "category": "correctness" | "security" | "architecture" | "tests" | "types" | "comments" | "style",
  "rule": "<doc-name>.md[#anchor]",
  "message": "<one-sentence problem>",
  "suggestion": "<one-sentence fix>"
}
```

### 4. Aggregate — dedup, drop low-confidence, sort

Combine findings from all sub-agents:

1. Concatenate all JSONL lines into one array
2. Drop any finding with `confidence < 80`
3. Group by `(file, line, category)` — keep one per group: max severity → max confidence → longest message
4. Sort by severity rank (CRITICAL=0, IMPORTANT=1, NIT=2), then file path alphabetical

### 5. Emit — structured stdout

Print a markdown summary followed by a fresh `findings` JSONL fence holding the aggregated set:

```
# Review report

**Diff**: <base description, e.g., "uncommitted changes" / "PR #123" / "branch vs main">
**Angles fired**: <list>
**Findings**: <N critical, M important, K nit>

[per-finding rendering grouped by severity]

```findings
<aggregated JSONL>
```
```

The caller (local CLI / PR-comment workflow / fix-bot reviewer / review-bot Agent B) reads this stdout and applies its own **action policy** per [design-code-review.md "Consumer action policies"](../../rules/design-code-review.md).

## What to do per consumer

This skill is policy-free. The consumer decides what severity means for them:

| Consumer | CRITICAL | IMPORTANT | NIT |
|---|---|---|---|
| Local CLI | Red text | Yellow | Grey |
| PR-comment trigger workflow | Inline PR comment + summary | Summary entry | Collapsed |
| Fix-bot reviewer (Agent B) | REJECT / NEEDS_HUMAN | REJECT with Note | Mention only |
| Review-bot Agent B | REJECT / NEEDS_HUMAN | REJECT with Note | Mention only |

## Skeleton phase — angle skills not yet present

This is Cut 2 of Phase 1 per [`design-code-review-implementation.md`](../../rules/design-code-review-implementation.md). The orchestrator + dispatch are in place; the six angle skills (`review-diff`, `review-tests`, `review-types`, `review-architecture`, `review-security`, `review-comments`) and the discovery skill (`audit-area`) land in cuts 3–9.

If invoked before the angle skills are present:

1. Run dispatch.sh to validate the table fires correctly
2. Print the would-be angle list to stdout
3. Emit an explicit message: "skeleton phase: angles not yet implemented; expected angles for this diff are: <list>"
4. Exit successfully — this validates the dispatch shape without depending on cuts 3–9

When the angle skills land, this skeleton becomes the production path; remove the skeleton-phase block and verify against the expanded e2e tests in Cut 10.

## Decision-log convention

Per [`bots/README.md`](../../../bots/README.md) decision-log convention, emit `> Decision: ...` notes inline as you walk the steps. Especially: which angles fired (cite the dispatch output) and any aggregation choices (e.g., "two findings at the same line; kept the higher-severity one per the design rule").

## Stop conditions

- Stop if dispatch returns no angles (impossible — `review-diff` always fires; if it doesn't, the dispatch logic broke and that's a bug, NOT a clean no-op)
- Stop if an angle sub-agent fails: log the failure inline, continue with remaining angles' findings, NOTE the gap in the report
- Stop if the diff is genuinely empty: emit an empty findings fence + prose "diff was empty"
