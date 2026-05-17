---
name: review-architecture
description: Review a diff against gazetta's 13 foundational dimensions, ADRs, and per-area design docs. Always loads CLAUDE.md + dev-glossary.md + the dimension list (the universal language). On-demand loads max 2 per-area design docs based on the diff's paths (hybrid context strategy). Catches violations of foundational contracts (audit shape, validator phase, hook lifecycle, capability scope, etc.) that generic review-diff misses. Fires when packages/gazetta/src/{audit,validation,hooks,auth,review,scheduling,soft-delete}/, .claude/rules/design-*.md, or docs/adr/ is touched.
allowed-tools: Bash Read Grep Glob
argument-hint: [--base <ref>] [--pr <N>]
---

# Review-architecture — Phase 2 angle

Gazetta is structured around 13 **foundational dimensions** (per [`feature-design-process.md`](../../rules/feature-design-process.md)) that compose with every feature. This angle catches diffs that break a foundational contract — a new validator firing at the wrong phase, a hook payload missing the Principal, an audit event omitting required fields, a capability with the wrong prefix, etc.

The angle uses **hybrid context loading**: always loads the universal-language anchors (CLAUDE.md + dev-glossary.md + the dimension list); reads at most 2 per-area design docs on demand based on diff paths.

See [`design-code-review.md`](../../rules/design-code-review.md) for the full design + the Q-decision that locked the hybrid strategy.

## What this angle owns

- Foundational-dimension contract violations on the changed lines (audit / validation / hooks / auth-rbac / review / scheduling / soft-delete / rendering / themes / locale / cache / offline / collaboration)
- ADR contradictions (changes that violate a documented architectural decision)
- Design-doc-vs-implementation drift (the diff modifies code in a way the design doc doesn't sanction)
- Cross-cutting concern omission (e.g., a new admin route that doesn't go through the capability check pattern; a new validator that doesn't follow the Validator interface)
- Multi-instance correctness violations (in-memory state that affects other instances; aggregate manifests where per-edge sidecars are required per [`team-preferences.md#24`](../../rules/team-preferences.md))
- Scale-envelope violations (O(N-pages) walks at request time / on hot paths per [`design-scale.md`](../../rules/design-scale.md))

## What this angle does NOT own

- Generic bugs / null handling / logic issues (`review-diff`'s job)
- Type design quality (`review-types`'s job — even though architecture often turns on types)
- Security per se (`review-security`'s job — though some security issues ARE architectural)
- Test quality (`review-tests`'s job)
- Whether the design doc itself is right (out of scope; if you suspect the design is wrong, that's a separate grilling pass via `/grill-with-docs`)

## Reads (always, every invocation)

These anchor the universal language. Read once at the start; don't re-read between findings.

- [`CLAUDE.md`](../../../CLAUDE.md) — project rules, "doing tasks" guidance, build/test conventions
- [`.claude/rules/dev-glossary.md`](../../rules/dev-glossary.md) — dev-process vocabulary (Skill, Bot, Reviewer, Generator-critic loop, etc.)
- [`.claude/rules/feature-design-process.md`](../../rules/feature-design-process.md) — the 13 foundational dimensions list + the six non-foundational disciplines

The dimension list itself (extract from feature-design-process.md's "Foundational dimensions" section):

1. Scale (`design-scale.md`)
2. Themes (`design-themes.md`)
3. Locale / i18n (`design-i18n.md`)
4. Auth + RBAC (`design-auth-rbac.md`)
5. Audit (`design-audit.md`)
6. Review workflow (`design-review-workflow.md`)
7. Hooks (`design-hooks.md`)
8. Rendering (`design-rendering.md`)
9. Validation (`design-validation.md`)
10. Plugin (`design-plugins.md`)
11. Cache (`design-cache.md`)
12. Offline (`design-offline.md`)
13. Collaboration (`design-collaboration.md`)

Plus the multi-instance discipline (not a dimension but a non-foundational gate per `feature-design-process.md`).

## Reads (on demand, max 2 per invocation)

Pick based on the diff's paths:

| Diff touches… | Read |
|---|---|
| `packages/gazetta/src/audit/` | `design-audit.md` |
| `packages/gazetta/src/validation/` | `design-validation.md` |
| `packages/gazetta/src/hooks/` | `design-hooks.md` |
| `packages/gazetta/src/auth/` | `design-auth-rbac.md` |
| `packages/gazetta/src/review/` | `design-review-workflow.md` |
| `packages/gazetta/src/scheduling/` | `design-scheduling.md` |
| `packages/gazetta/src/soft-delete/` | `design-soft-delete.md` |
| `packages/gazetta/src/{publish,sitemap,sidecars}` | `design-publishing.md` + `sidecars.md` |
| `packages/gazetta/src/renderer/`, `packages/gazetta/src/render-*` | `design-rendering.md` |
| `packages/gazetta/src/providers/` | `design-provider-config.md` |
| `packages/gazetta/src/assets/` | `design-media.md` |
| `packages/gazetta/src/cache/` | `design-cache.md` |
| Files implementing the offline/PWA layer | `design-offline.md` |
| `packages/gazetta/src/i18n/` or `*locale*` | `design-i18n.md` |
| `packages/gazetta/src/cli/` | `CLAUDE.md` "Build & Test" only — no extra read |
| `.claude/rules/design-X.md` (modifying a design doc) | THAT design doc itself |
| `docs/adr/NNNN-X.md` (modifying an ADR) | THAT ADR itself + the design doc it links from |

**Hard cap: 2 per invocation.** If the diff touches 5 different foundational areas, pick the 2 with the largest blast-radius. Context budget matters even for review.

When the diff modifies a design doc itself, ALWAYS read that design doc and consider:
- Does the change contradict a locked decision (the "Distinctive choices" table)?
- Does the change require an ADR (per ADR criteria: hard to reverse + surprising + real trade-off)?
- Does the change require a glossary update?

## Severity assignment

Per the locked severity model:

| Severity | When |
|---|---|
| **CRITICAL** | Foundational-contract violation that will compound (e.g., new audit event missing required fields per `design-audit.md`; new validator at wrong phase; in-memory cross-instance state per multi-instance discipline) |
| **IMPORTANT** | Cross-cutting concern not respected; rule violation; design-doc-vs-code drift; missing dimension-check in a new design doc |
| **NIT** | Minor architectural-style preference; could-be-cleaner suggestion |

Confidence ≥ 80 to emit. **Be especially aggressive about confidence filtering here** — architectural judgments are higher-stakes and "feels wrong" without specifics isn't actionable.

## Process

### 1. Load universal context

Read CLAUDE.md + dev-glossary.md + feature-design-process.md (the dimension list). One read each; don't re-read.

### 2. Determine the relevant area

Look at the diff's paths. Apply the path table above. Pick at most 2 design docs to read on demand.

If the diff touches multiple foundational areas, prioritize by:
- New file under a foundational dir > modification to existing file
- Modification to public surface > internal helper change
- Modification to design-*.md itself > implementation-only change

### 3. Read the relevant design docs (max 2)

For each picked doc, read the "Foundational checks" section + the "Distinctive choices" table + the "Locked invariants" / "Scope" sections. Skim the rest.

### 4. Walk the diff against the contract

For each changed file or section, ask:
- Does this respect the foundational contract documented in the design doc?
- Does this maintain the multi-instance invariant (per-edge sidecars or storage-as-message-bus, never in-memory cross-instance state)?
- Does this respect the 5K-envelope scale gate (no O(N-pages) walks on hot paths)?
- Does this contradict any "Distinctive choices" entry?
- If a new validator/hook/audit-action/capability is introduced, does it conform to the canonical shape?

### 5. Check the broader dimension matrix

Walk briefly through the 13 dimensions + multi-instance discipline. For each, ask: "does this diff have a relevant interaction with this dimension?" Most diffs touch 1-3 dimensions; the rest are N/A. The dimensions that DO apply are where findings come from.

### 6. Form findings + cite the rule

Every finding cites a design doc + section/anchor. Examples:

- `rule: "design-audit.md#audit-event-shape"`
- `rule: "design-validation.md#validator-stages"`
- `rule: "team-preferences.md#24"` (5K-envelope discipline)
- `rule: "feature-design-process.md#multi-instance-discipline"`
- `rule: "docs/adr/0008-provider-factory-returns-instance.md"` (when an ADR is violated)

### 7. Emit prose + findings fence

Above the fence, emit `> Decision: ...` notes for:
- Which design docs you loaded (cite the path)
- Which dimensions you walked (briefly — "audit + validation; others N/A")
- Which findings cleared ≥ 80; which were dropped (and why)

Findings fence (possibly empty):

````
```findings
{"severity":"CRITICAL","file":"packages/gazetta/src/audit/recorder.ts","line":47,"confidence":92,"category":"architecture","rule":"design-audit.md#audit-event-shape","message":"new audit event omits `outcome` field required by AuditEvent schema; will fail downstream consumers that filter by outcome","suggestion":"add `outcome: 'success'` per the AuditEvent shape in design-audit.md"}
```
````

When NO findings ≥ 80 confidence:

````
> Decision: loaded CLAUDE.md + dev-glossary.md + feature-design-process.md (universal). Loaded design-validation.md (diff touches packages/gazetta/src/validation/). Walked diff against validator-phase contract + multi-instance discipline + scale envelope. No concerns ≥ 80 confidence.

```findings
```
````

## Anti-patterns (illustrative)

**Audit event missing required fields:**
```ts
emitAudit({ action: 'review-submit', actor })  // missing outcome + scope
```
→ Per `design-audit.md` audit-event-shape, every event has `action, outcome, actor, scope` minimum.

**Validator at wrong phase:**
```ts
// new validator that requires rendered output, but registered at save-delta phase
export const orphanLocaleValidator: Validator = {
  stages: ['save-delta', 'background', 'pre-publish'],  // save-delta is wrong — needs full-site
  ...
}
```
→ Per `design-validation.md` validator-stages, save-delta is O(diff) only.

**In-memory cross-instance state:**
```ts
const recentReviews = new Map<string, ReviewState>()  // module-level Map shared across requests
```
→ Per multi-instance discipline + `team-preferences.md#24`, state that affects other instances must go through shared storage with appropriate granularity (per-edge sidecars or atomic blob writes).

**O(N-pages) walk on a hot path:**
```ts
// in a publish-time loop:
for (const page of allPages) {
  for (const otherPage of allPages) {  // O(N²)
    if (otherPage.aliasOf === page.name) {...}
  }
}
```
→ Per `design-scale.md` + `team-preferences.md#24`, build a per-edge sidecar index instead.

**Capability with wrong prefix:**
```ts
const cap: Capability = 'search:rebuild-index' // built-in prefix?
```
→ Per `design-auth-rbac.md` capability-shape, built-in prefixes (read / edit / delete / publish / configure / review / restore / comment / mention / subscribe) are reserved; plugins use plugin-specific prefixes.

**Design doc modification that contradicts a locked decision:**
```diff
// .claude/rules/design-audit.md
- We pick per-event recording with no batching.
+ We pick batched recording with N-second flush windows.
```
→ Check whether this is a real re-litigation (with rejected alternatives walked) or an undocumented departure from a locked invariant. CRITICAL or IMPORTANT depending.

## What NOT to flag

- "This could be more idiomatic" without citing a specific dimension or ADR
- Style violations (CLAUDE.md cosmetic rules — that's `review-diff`)
- Design ideas the dimension docs don't address (those belong in a design-grilling session, not in a review finding)
- Concerns about dimensions whose design pass hasn't shipped (the design doc is the contract; if it doesn't exist, you can't violate it — flag with NIT severity at most, with a note that the dimension is pending)
- Changes the user is making AS PART OF a documented design pass (the dimension itself is being redesigned; review-architecture's role is to check that the redesign is well-shaped, not that it conforms to the prior version)

## When to invoke

Fires from the orchestrator when the dispatch detects foundational paths or design-*.md / docs/adr/ changes (per `bots/_lib/review-dispatch.ts:matchesArchitecture`). Direct invocation (`/review-architecture`) is supported for focused review.

Also invoked from fix-bot's reviewer Step 3 (replacing the previous project-rule check).

## Stop conditions

- Stop if the diff has no architectural paths AND no foundational-area touches: emit empty fence + prose explaining what dimensions you confirmed didn't apply
- Stop after walking the relevant dimensions; emit findings (possibly empty)

## Decision-log convention

Per [`bots/README.md`](../../../bots/README.md) decision-log convention, emit `> Decision: ...` notes for:
- Which 2 design docs you picked (and why — usually "diff touches X primarily")
- Which dimensions you walked
- Which findings cleared ≥ 80; explicitly note dropped candidates with reasoning (rule 27 — label assertion provenance: "from `design-audit.md` line N" vs "intuition — un-verified")
- When a finding turns on a multi-instance or scale concern, name the discipline + the specific gate (e.g., "5K-envelope violation: O(N-pages) walk on publish hot path")
