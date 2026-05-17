---
name: audit-area
description: Phase 1 Discovery skill — given a path or paths, scan the area and produce a ranked list of candidate improvements. Forward-looking ("what's worth changing here?") complement to the diff-shaped Phase 2 evaluation skills. Internally applies the angle lenses (security / architecture / tests / types / comments / general) but in candidate-ranking mode, not finding-emission mode. Used by review-bot's Phase 1, by /audit-area interactive, and by @claude audit <path> on PRs.
allowed-tools: Bash Read Grep Glob
argument-hint: <path> [<path> ...] [--focus <angle>]
---

# Audit-area — Phase 1 discovery

The Phase 1 discovery skill. Given one or more paths, walks the code as it exists today and surfaces candidate improvements ranked by severity. Forward-looking: "what's worth changing here?" — the complement to Phase 2's "is this proposed diff good?"

See [`design-code-review.md`](../../rules/design-code-review.md) and [ADR-0013](../../../docs/adr/0013-code-review-two-phase-model.md) for the load-bearing two-phase model.

## Use cases

| Trigger | Caller |
|---|---|
| `/audit-area packages/gazetta/src/auth/` | Local CLI — interactive audit before a refactor |
| `@claude audit packages/gazetta/src/admin-api/` | PR-comment trigger workflow — operator wants an area surveyed |
| Review-bot Phase 1 | Autonomous review-bot's discovery step: TS picks the area; audit-area finds candidates; bot's Agent A makes the top candidate's change |

## Inputs

- **paths** (required, 1+): repo-relative paths or directories to audit. Examples: `packages/gazetta/src/auth/`, `packages/gazetta/src/admin-api/routes/`.
- **focus** (optional): hint to narrow lens — `security`, `architecture`, `tests`, `types`, or omitted (full sweep across all lenses).

## Output — candidates fence

Like Phase 2 skills, the output is prose-with-Decisions above + JSONL fence below. The fence schema is DIFFERENT from Phase 2:

```json
{
  "area": "<repo-relative path>",
  "type": "security" | "architecture" | "tests" | "types" | "comments" | "style" | "correctness",
  "severity": "CRITICAL" | "IMPORTANT" | "NIT",
  "summary": "<one-sentence problem statement>",
  "suggested_action": "<one-sentence starting point for the fix; cites design doc + path/line when applicable>",
  "confidence": <0-100>,
  "rule": "<doc-name>.md[#anchor] | <file-name>:<line>"
}
```

Fields differ from Phase 2 findings:
- `area` (path) replaces `file` + `line` (candidates are area-scoped, not line-scoped — though the `suggested_action` may include specific line refs)
- `summary` replaces `message` (forward-looking problem statement)
- `suggested_action` replaces `suggestion` (load-bearing — Agent A reads this to know how to start)
- No `category` field; `type` carries the same info but as the Phase 1 vocabulary

## Process

### 1. Read the paths

For each input path:
- If it's a directory, walk recursively (skip `node_modules/`, `dist/`, `.gazetta/`)
- If it's a file, read it directly
- Bound the read budget — for very large dirs (>50 files), sample by importance (start with `index.ts`, then route files, then helpers)

### 2. Pick which lenses to apply

If `--focus <angle>` is set: only that lens.

If no focus: full sweep, but in candidate-mode (one candidate per lens per pattern, ranked) — not exhaustive enumeration like Phase 2.

Lenses available (mirror the Phase 2 angle skills):

| Lens | What it surfaces |
|---|---|
| **security** | Missing capability gates, SSRF risk, unsanitized rendering, secret leakage, weak crypto |
| **architecture** | Dimension violations, ADR contradictions, foundational-contract drift, multi-instance state, scale-envelope risk |
| **tests** | Files without test coverage, tautological-looking tests, tier-shape mismatches, isolation issues |
| **types** | Stub-throws, schema/type duplication, anemic models, stringly-typed APIs |
| **comments** | Areas with high comment-rot density (heuristic; rarely worth a candidate) |
| **correctness** (general bugs, dead code) | Code that's clearly wrong or unreachable but hasn't been flagged |
| **simplify** | Areas with high complexity / unnecessary abstraction (rare; usually scope creep) |

### 3. Always-load context (anchored on dev-process language)

- [`CLAUDE.md`](../../../CLAUDE.md) — project rules
- [`.claude/rules/dev-glossary.md`](../../rules/dev-glossary.md) — vocabulary
- For the picked focus or any lens that hits findings: read the relevant design doc on demand (max 2)

Same hybrid-context strategy as `review-architecture`.

### 4. Walk the code; collect candidate improvements

For each file in the audited area:
- Apply the relevant lens checklists (security → capability gates, SSRF, etc.; architecture → foundational checks, etc.)
- Surface IMPROVEMENT candidates, not point-bug-findings. A candidate is a piece of work worth proposing — typically requires touching 1-5 files to address.

Examples of candidates:
- "Capability check missing on 3 admin routes" (security; affects multiple files in the area)
- "Validator declares wrong phase array" (architecture; one file but high blast radius)
- "Test isolation: 4 test files share module-level tempDir" (tests; pattern across files)
- "Asset-refs walker uses O(N-pages) scan instead of sidecar" (architecture + scale; one function but design-doc relevant)

NOT candidates:
- Single-line typo in a comment (too narrow; not worth a PR)
- "This could be slightly cleaner" without a specific issue (too vague; the LLM-pick step in review-bot Phase 0 would reject)
- Findings that would belong in `review-diff` on a proposed diff (the diff doesn't exist yet)

### 5. Rank candidates

For each candidate, assign:
- **type** — which lens surfaced it
- **severity** — CRITICAL / IMPORTANT / NIT per the locked model (security CRITICAL = privilege escalation; architecture CRITICAL = foundational-contract break; etc.)
- **confidence** — ≥ 80 floor; for candidates that span multiple files, be conservative
- **suggested_action** — concrete starting point: which file, which design doc, what to do first

Sort candidates by severity (CRITICAL → IMPORTANT → NIT), then confidence (descending). Cap output at 10 candidates per invocation (more than that overwhelms the LLM caller in review-bot's Phase 2 pick step).

### 6. Cite the rule

Every candidate has a `rule` citation. Same conventions as Phase 2:
- `design-auth-rbac.md#capability-gate` for security
- `design-validation.md#validator-stages` for architecture
- `team-preferences.md#26` for test isolation
- `team-preferences.md#24` for scale envelope
- `<file-name>:<line>` when the issue is pure code with no doc

### 7. Emit prose + candidates fence

Above the fence:
- `> Decision: which path(s) were audited`
- `> Decision: which lenses fired (focus argument or full sweep)`
- `> Decision: how many candidates surfaced; brief summary by severity`

Candidates fence:

````
```candidates
{"area":"packages/gazetta/src/auth/","type":"security","severity":"IMPORTANT","summary":"capability check missing on 3 admin routes (/api/admin/users, /api/admin/roles, /api/admin/audit-log)","suggested_action":"add `requireCapability('admin:users' | 'admin:roles' | 'admin:audit-log')` middleware to each route per design-auth-rbac.md#capability-gate. Start with /api/admin/users (lowest-risk for the fix; the others follow the same pattern.","confidence":85,"rule":"design-auth-rbac.md#capability-gate"}
{"area":"packages/gazetta/src/auth/","type":"tests","severity":"NIT","summary":"3 test files exceed 200 lines; testing-plan.md suggests splitting","suggested_action":"split auth.test.ts into auth-principal.test.ts + auth-capability.test.ts + auth-trust-mode.test.ts","confidence":80,"rule":"testing-plan.md#test-file-size"}
```
````

### When NO candidates ≥ 80 confidence:

````
> Decision: walked packages/gazetta/src/admin-api/routes/. Applied security + architecture + tests lenses (no focus argument). No candidate improvements ≥ 80 confidence — the area's capability gates are consistent, the routes follow the canonical pattern, tests look behavioral. Nothing structurally wrong worth proposing as a PR right now.

```candidates
```
````

Empty candidates fence + prose-what-was-checked is a definite outcome: "I looked and there's nothing worth doing here right now."

## Boundary conditions

- **One-line typo fixes don't earn candidates.** They earn `review-diff` findings on a proposed diff. Candidates are PR-worthy units of work (typically ≥ 1 file modified).
- **Don't propose architectural overhauls.** Candidates are scoped fixes that fit a single PR. "Refactor the validation framework to use a different abstraction" is design-grilling territory, not a candidate.
- **Don't propose changes that contradict locked decisions.** When you find code that's "wrong" per upstream best-practices but matches a locked decision in `design-X.md`, the design wins. Surface it as a NIT only if the code is clearly suboptimal AND the design doesn't preclude the better approach.
- **Don't propose changes in skip-listed areas.** If review-bot's TS layer passed skip-list context, defer to it; this is producer work, not your job.

## Anti-patterns this skill catches (illustrative)

When auditing `packages/gazetta/src/auth/`:

- **Missing capability gates** (security/IMPORTANT — multiple routes need them)
- **`Principal` read without capability check** (security/CRITICAL — privilege escalation)
- **`@admin` shape from `design-auth-rbac.md` ignored** (architecture/IMPORTANT — contract drift)
- **Audit events from auth missing required fields** (architecture/CRITICAL — feeds downstream consumers)

When auditing `packages/gazetta/src/admin-api/routes/`:

- **Routes without `requireCapability(...)` middleware** (security/CRITICAL or IMPORTANT)
- **Routes that return raw env vars or stack traces in error responses** (security/CRITICAL — secret leak)
- **Routes that don't go through the Zod schema validation pattern** (architecture/IMPORTANT — discipline)

When auditing test directories:

- **Module-level mutable state across tests** (tests/IMPORTANT — rule 26)
- **Files with no tests** (tests/IMPORTANT — coverage gap; suggest writing tests)
- **Tautological-looking patterns** (tests/IMPORTANT — counterfactual fails)

## What NOT to surface

- "This file is too long" (style; not a PR-worthy candidate by itself)
- "This name could be clearer" (nit; not worth a PR)
- "This could use a different test library" (out of scope; not a code change)
- "This area has technical debt" (too vague; identify a specific debt slice)
- "Consider adding monitoring" (out of scope unless `design-logging.md` says it should already exist)

## When to invoke

- **Local CLI**: `/audit-area packages/gazetta/src/auth/` (interactive)
- **PR comment**: `@claude audit packages/gazetta/src/admin-api/` (workflow-driven)
- **Review-bot Phase 1**: orchestrator passes a single path picked by Phase 0 + optional focus from area-scorer's hints

This skill is NOT invoked by the Phase 2 review-orchestrator (different phase, different question).

## Stop conditions

- Stop after walking each input path
- Cap candidates at 10 per invocation; if more would qualify, mention in prose ("surfaced 10; ~3 more candidates exist below the cap")
- Stop if the path doesn't exist (emit prose explaining + empty candidates fence)

## Decision-log convention

Emit `> Decision: ...` notes for:
- Which path(s) audited; how many files walked
- Which lenses applied (focus arg vs full sweep)
- Top candidates surfaced + their confidence; explicit note when a candidate is borderline (≥ 80 but with caveats)
- Candidates dropped at < 80 confidence — note WHY (especially for security candidates, where dropping is a higher-stakes decision)
