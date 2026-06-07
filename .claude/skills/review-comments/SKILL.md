---
name: review-comments
description: Review comment accuracy, rot, and completeness on the diff. Fires when the diff is comment-only OR includes comment changes. Looks for: comment-says-X-but-code-does-Y mismatches, redundant comments that restate obvious code, stale references to refactored code, examples that don't match current implementation, TODOs that may have been addressed.
allowed-tools: Bash Read Grep Glob
argument-hint: [--base <ref>] [--pr <N>]
---

# Review-comments — Phase 2 angle

Comments are technical debt that compounds quietly. This angle catches comment rot — comments that describe what the code USED to do, comments that restate the obvious, examples that drifted from the current implementation, TODOs left behind after the fix landed.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design + skill family.

## The governing bar: a comment must be impossible to rot

The standard is **not "accurate today" — it is "survives an arbitrary rewrite of the code beneath it."** A comment that correctly describes the code now is still a finding if a future rewrite would falsify it. For every comment ask:

> **"If someone rewrites this code, does the comment go stale?"**

- **Yes → rot-prone.** Flag it: rewrite to the durable WHY behind it, or remove. Rot-prone shapes (flag even when accurate today): restates WHAT the code does (`// increment i` over `i++`), describes the current algorithm, or names volatile anchors — local symbol names, line numbers, "the function below", quoted example output.
- **No → keep.** A comment survives only by stating what the code can't: a non-obvious WHY, an externally-imposed constraint (spec, protocol, platform quirk, locked design decision), a durable design linkage (design-doc section or `ADR-NNNN` — durable anchors are fine, line numbers and local symbols are not), or a warning about a non-obvious consequence.

## What this angle owns

- **Rot-prone comments** — accurate today but a rewrite would stale them (the governing bar)
- Comments that contradict the code they sit next to ("returns null when empty" but the code throws)
- Stale references to functions/variables that have been renamed or removed
- Examples in JSDoc that don't compile or call deleted APIs
- TODOs / FIXMEs whose underlying issue appears resolved by this same diff
- Misleading or outdated assertions about complexity, thread-safety, or invariants

## What this angle does NOT own

- Documentation files (`docs/**.md`, `README.md`) — those are reviewed as content, not as code comments
- Comments inside test files describing test intent — those are part of test quality (`review-tests`)
- Whether NEW comments should exist at all (that's per-line judgment the author makes); we review whether comments that exist meet the rot-proof bar

## Reads (always)

- [`CLAUDE.md`](../../../CLAUDE.md) "Doing tasks" section — specifically the "default to writing no comments" rule and the "explain WHY not WHAT" guidance

## Process

### 1. Walk every comment change in the diff

Look at lines starting with `//`, `/*`, `*`, `#`, or `<!--` that were added or modified. For each, ask:

- **Rot-proofness** (the governing bar): would a future rewrite of the code beneath this comment falsify it? If yes, it's rot-prone — flag it even if it's accurate today.
- **Accuracy**: does the comment match what the adjacent code actually does?
- **Necessity**: would removing the comment hide a non-obvious WHY? If no, the comment is redundant per CLAUDE.md.
- **Currency**: does the comment reference functions / variables / behavior that still exist?
- **Examples**: are JSDoc `@example` blocks runnable against the current API?

### 2. Walk every code change for orphaned comments

When code changed but a nearby comment wasn't touched, ask: does the unchanged comment still describe the changed code? Comment rot is highest at the boundary of "comment didn't change but code did."

### 3. Form findings

For each candidate finding:

| Severity | When |
|---|---|
| **CRITICAL** | Comment actively misleads in a way that would cause a user/maintainer to write incorrect code (e.g., "this function is async" but it's sync; a usage example that calls a deleted function) |
| **IMPORTANT** | Comment is materially wrong but obvious from the code (e.g., "returns true on success" but the code returns the result) |
| **NIT** | Comment restates obvious code (CLAUDE.md violation); rot-prone but accurate today (describes the impl / names volatile anchors); minor wording drift |

Confidence threshold ≥ 80 to emit.

### 4. Cite the rule

For comment rot the rule citation is typically:
- `CLAUDE.md` — when the issue is a documented project rule (no obvious-restating; WHY not WHAT)
- `<file-name>:<line>` — when the issue is purely a comment-vs-code mismatch (the code at that line is the authoritative reference)

### 5. Emit prose + findings fence

Same structure as every Phase 2 angle: prose with `> Decision: ...` notes above; JSONL findings fence (possibly empty) below.

When NO findings ≥ 80 confidence:

````
> Decision: walked N comment changes across M files. Looked for accuracy mismatches, redundancy per CLAUDE.md, stale references, drifting examples. No concerns ≥ 80 confidence.

```findings
```
````

## Anti-patterns (illustrative)

**Comment-vs-code mismatch:**
```ts
// Returns null when the user is not found.
function findUser(id: string): User {
  const user = db.get(id)
  if (!user) throw new Error(`user ${id} not found`)  // throws, doesn't return null
  return user
}
```

**Redundant comment (CLAUDE.md violation):**
```ts
// Loop through items
for (const item of items) {
  // increment count
  count++
}
```

**Stale reference:**
```ts
// Calls validateOrder() before persisting (see order-validator.ts:42)
function persist(order: Order) {
  // order-validator.ts was deleted last quarter; this comment is rot
}
```

**Drifted example:**
```ts
/**
 * @example
 * createUser({ name, email, role })  // signature actually changed to (name, opts)
 */
function createUser(name: string, opts: CreateUserOpts) {
```

**Misleading invariant:**
```ts
// O(1) lookup
function find(id: string) {
  return arr.find(x => x.id === id)  // actually O(n)
}
```

**Rot-prone though accurate-today (fails the governing bar):**
```ts
// Loops over targets and merges each one's reviewWorkflow into the result
function resolve(site, target) {
  return target.reviewWorkflow ?? site.reviewWorkflow  // describes an impl
}                                                       // a rewrite would stale
// → rewrite to the WHY ("per-target override is atomic per
//   design-review-workflow.md — no field merge"), or delete.
```

## What NOT to flag

- New comments that the author chose to write — per CLAUDE.md, the bar is "non-obvious WHY"; if the comment passes that bar, don't nitpick
- Comments inside test files describing test purpose (that's part of `review-tests` if relevant)
- Differences between the codebase's commenting style and an idealized one
- Auto-generated comments (JSDoc tooling, license headers)
- Comments that are LIGHTLY redundant but document a load-bearing invariant the code can't enforce (e.g., "MUST be called before init"); these earn their keep

## When to invoke

Fires from the orchestrator when the dispatch detects comment-only changes. Also fires implicitly when other angles fire (because comment changes often accompany code changes); however, the dispatch only adds this angle explicitly when a diff is dominated by comment changes — to avoid running it on every PR that happens to include a comment update.

Direct invocation (`/review-comments`) is supported for focused review.

## Stop conditions

- Stop if the diff has no comment changes (empty fence + prose "no comment changes in this diff")
- Stop after walking all comment changes; emit findings (possibly empty)

## Decision-log convention

Emit `> Decision: ...` notes for: which comments fired findings, which were dropped at <80 confidence (and why — usually "looks subjective"), and any pattern you noticed across the diff (e.g., "consistent rot pattern: all comments reference the old API shape that was renamed two commits ago — author may have missed sweep").
