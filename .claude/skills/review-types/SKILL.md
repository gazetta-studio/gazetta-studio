---
name: review-types
description: Review type design on the diff — Zod schemas, TS interfaces, type aliases, capability interfaces. Rates each new/modified type on encapsulation, invariant expression, usefulness, and enforcement. Flags illegal-states-representable, anemic types, missing constructor validation, stub-throws-not-implemented patterns. Fires when the diff includes z.object/interface/type declarations.
allowed-tools: Bash Read Grep Glob
argument-hint: [--base <ref>] [--pr <N>]
---

# Review-types — Phase 2 angle

Type design is the foundation that determines how much the compiler can catch and how much shifts to runtime. This angle judges each new or modified type along four dimensions and flags anti-patterns that make types weaker than they should be.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design + skill family. See the upstream `type-design-analyzer` agent in the [pr-review-toolkit](https://github.com/anthropics/claude-skills) plugin for the four-dimension framework's origin.

## What this angle owns

- New / modified Zod schemas (`z.object`, `z.union`, `z.discriminatedUnion`, etc.)
- New / modified TypeScript `interface` declarations
- New / modified `type` aliases (especially branded types and discriminated unions)
- Capability interfaces (`*Capable*`, `*Provider`, etc.) — interfaces that not every implementation must satisfy
- Type-level invariant patterns (illegal-states-unrepresentable, branded types, exhaustive switches)

## What this angle does NOT own

- Whether the file should HAVE types (it should; this is a TypeScript-strict codebase)
- Type errors that `tsc --noEmit` would catch (that's build verification, not review)
- Runtime behavior of the code that uses these types (`review-diff`'s job)
- Whether validators built atop these schemas fire at the right phase (`review-architecture`'s job)

## Reads (always)

- [`CLAUDE.md`](../../../CLAUDE.md) — TypeScript strict mode, composition over inheritance, single-responsibility patterns
- [`.claude/rules/team-preferences.md`](../../rules/team-preferences.md) rule 5 (types infer from Zod) and rule 18 (build structurally right; no stub-throws)

## Reads (on demand)

When the diff modifies a type in a known design surface:

| When the diff touches… | Read |
|---|---|
| Provider interfaces (`StorageProvider`, `TransformAdapter`, etc.) | [`design-provider-config.md`](../../rules/design-provider-config.md) |
| `Capability` types | [`design-auth-rbac.md`](../../rules/design-auth-rbac.md) |
| Audit event shapes | [`design-audit.md`](../../rules/design-audit.md) |
| `Validator` interface | [`design-validation.md`](../../rules/design-validation.md) |

Read at most ONE additional doc per invocation.

## Four-dimension rating

For each NEW or MATERIALLY MODIFIED type, rate 1-10 on:

| Dimension | Question |
|---|---|
| **Encapsulation** | Can the type's invariants be violated from outside? Are internals appropriately hidden? Is the interface minimal? |
| **Invariant Expression** | How clearly are invariants communicated through the structure? Are invariants compile-time-enforced where possible? |
| **Invariant Usefulness** | Do the invariants prevent real bugs? Are they aligned with the domain? Not too restrictive, not too permissive? |
| **Invariant Enforcement** | Are invariants checked at construction? Are mutation points guarded? Is it impossible to create invalid instances? |

A type rating ≤ 4 on any dimension is a candidate finding. Severity follows the locked model:

- **CRITICAL** if the type permits illegal states that will manifest as bugs in production (≥ 90 confidence)
- **IMPORTANT** if the type is weaker than it should be in a way that compounds maintenance cost (≥ 80 confidence)
- **NIT** if a stronger type exists but the gap is small / context-dependent (≥ 80 confidence)

## Process

### 1. Identify new and modified types in the diff

Look for added or modified:
- `z.object(...)`, `z.union(...)`, `z.discriminatedUnion(...)`, `z.enum(...)`
- `interface Foo { ... }`
- `type Foo = ...`
- `class Foo { ... }` declarations (if any; the codebase prefers composition over inheritance per CLAUDE.md)

### 2. Rate each on the four dimensions

For each type, walk the four dimensions. The rating doesn't appear in the findings fence (the consumer doesn't need it); use it internally to decide whether the type earns a finding.

### 3. Flag specific anti-patterns

These earn findings regardless of the four-dimension rating:

| Anti-pattern | Severity |
|---|---|
| **Stub throws `not implemented`** to satisfy an interface (rule 18) | CRITICAL or IMPORTANT |
| **Anemic model**: a class/interface with only fields, no behavior, but the surrounding code performs operations that belong on the type | IMPORTANT or NIT |
| **Exposed mutable state**: type exposes a mutable array/object reference that callers could mutate to break invariants | IMPORTANT |
| **Invariants enforced only by documentation**: comments saying "must be called before X" with no compile-time prevention | IMPORTANT or NIT |
| **Wide union without discriminant**: `type T = A \| B \| C` where the consumer has to inspect properties to know which | NIT (unless it bites) |
| **Stringly-typed when a branded type / literal union would work**: `function setRole(role: string)` accepting any string | IMPORTANT or NIT |
| **Capability lumped into base interface**: e.g., `readStream` on every `StorageProvider` even though not all support binary | IMPORTANT (per ADR-0004) |
| **Schema-vs-type duplication**: a Zod schema AND a separate TS interface for the same shape (should use `z.infer<typeof schema>` per rule 5) | IMPORTANT |

### 4. Cite the rule

For type findings the citation is typically:
- `team-preferences.md#5` — when the issue is the Zod-as-single-source-of-truth rule
- `team-preferences.md#18` — when the issue is stub-throws / structural-correction-not-patch
- `design-provider-config.md` / `design-auth-rbac.md` / similar — when the issue is a Provider/Capability interface that conflicts with its design contract
- `<file-name>:<line>` — when the issue is purely about the type definition with no doc to cite

### 5. Emit prose + findings fence

Above the fence, emit `> Decision: ...` notes:
- Which types you reviewed (by name)
- Which dimensions were weak (briefly)
- Which findings made the ≥80 cut

Findings fence below:

````
```findings
{"severity":"IMPORTANT","file":"packages/gazetta/src/foo.ts","line":42,"confidence":85,"category":"types","rule":"team-preferences.md#5","message":"Schema FooSchema duplicates the TS interface Foo defined on line 22; types should infer from Zod via z.infer<typeof FooSchema>","suggestion":"remove the interface declaration; add `export type Foo = z.infer<typeof FooSchema>`"}
```
````

When NO findings ≥ 80 confidence:

````
> Decision: walked N new/modified types; rated each on encapsulation, invariant expression, usefulness, enforcement; no concerns ≥ 80 confidence.

```findings
```
````

## Anti-patterns (illustrative)

**Stub throws — rule 18 violation:**
```ts
class FilesystemStorage implements StorageProvider {
  readStream(path: string): ReadableStream {
    throw new Error('not implemented')  // forces every caller to defensively check
  }
}
```
→ Should be a capability interface (`BinaryStorage` extends `StorageProvider`) with a type guard, not a stub.

**Stringly-typed:**
```ts
function setSeverity(level: string) { ... }
```
→ `function setSeverity(level: 'CRITICAL' | 'IMPORTANT' | 'NIT')`

**Schema/type duplication (rule 5):**
```ts
const FooSchema = z.object({ name: z.string(), age: z.number() })
interface Foo {                               // ← duplication
  name: string
  age: number
}
```
→ `export type Foo = z.infer<typeof FooSchema>`

**Invariant in comment, not in type:**
```ts
/** age MUST be non-negative */
interface User { age: number }
```
→ `interface User { age: number & { __nonNegative: true } }` (branded) or runtime validation at construction with a `User.create()` factory.

## What NOT to flag

- Plain `const foo: string = ...` declarations (not type design)
- Existing types in the codebase that the diff doesn't modify (out of scope; that's `audit-area`'s job if the user wants a sweep)
- Personal preferences about whether interfaces or type aliases are "more idiomatic"
- Type-of-the-week patterns (template literal types, conditional types) that the codebase doesn't use; suggest only when there's a concrete invariant they'd express better

## When to invoke

Fires from the orchestrator when the dispatch detects `z.object`/`interface`/`type` introduction in the diff (per `bots/_lib/review-dispatch.ts:matchesTypes`). Direct invocation (`/review-types`) is supported for focused review.

## Stop conditions

- Stop if the diff has no new or modified types: emit empty fence + prose
- Stop after rating all detected types; emit findings (possibly empty)

## Decision-log convention

Emit `> Decision: ...` notes for: which types you rated, which dimensions came up weak, which findings cleared ≥80. Cite anti-patterns by name when applicable ("flagged Capability lumped into base interface per ADR-0004").
