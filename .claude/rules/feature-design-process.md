# Feature Design Process

How Gazetta approaches feature design and implementation. Written so a new contributor (human or LLM agent) can pick up cold and follow the same workflow.

This is the resumability contract: **every kind of work we do has a designated durable artifact**. If a session ends without producing the right artifact, the work is lost.

## The four phases of feature work

### 1. Discovery

Understand the problem. Read existing design docs, audit competitor approaches, talk to users, read the relevant issues. Identify what's actually being asked and what's tangential.

**Durable artifact**: usually none — discovery feeds into design. If the discovery is large enough to be reusable (e.g., a CMS feature audit, a competitor analysis), capture it as a research doc under [`docs/audits/`](../../docs/audits/).

### 2. Grilling

Walk down each branch of the design tree, resolving decisions one-by-one. For each open question, present alternatives and a recommended answer. Capture rationale.

The grilling pattern (per the `grill-with-docs` skill):
- Ask one question at a time
- For each question, list alternatives
- Recommend an answer with reasoning
- Wait for confirmation
- Move on

**Durable artifact**: a design doc — see Phase 3.

### 3. Design

Capture what we're building, why, and the model.

**Durable artifacts** (this is the contract):

| File | Purpose | Required? |
|---|---|---|
| `.claude/rules/design-{feature}.md` | The design itself: scope, principles, model, distinctive choices, what's in/out of scope | **Required** |
| `.claude/rules/design-{feature}-implementation.md` | Build plan: cut sequence, scope per cut, effort estimates, deferred items, status table | **Required** |
| `.claude/rules/design-{feature}-reference.md` | Optional: fact-checked tooling specifics, library versions, citations | Optional — used when there are many fact-checked external claims (see media-v1 for example) |
| `docs/adr/NNNN-slug.md` | Architecture Decision Record | Optional — only when the decision passes the three ADR criteria (hard to reverse, surprising without context, real trade-off) |

**Required sections in a `design-{feature}.md`:**

- **Scope** — what's in v1.X, what's out, what's a non-goal
- **Companion docs** — link to implementation + reference + ADRs
- **Design model / architecture** — the actual structure
- **Distinctive choices** — what we picked vs. what we rejected, with reasons. Future-you re-litigates without these.
- **Migration** — for existing sites if applicable
- **Open questions** — known unresolved items

**Required sections in a `design-{feature}-implementation.md`:**

- **Status legend** (✓ shipped · ◐ in progress · ☐ pending)
- **Status table** — one row per cut with: cut number, what, effort estimate, dependencies, status
- **Per-cut scope** — files added/modified, tests, risk, what it doesn't catch yet
- **Deferred items** — what's out of THIS feature scope; trigger to revisit
- **SOLID checks per cut** — explicit; not implicit

The status table updates as cuts ship. When the feature is fully shipped, the implementation doc trims to "what was deferred" + "lessons learned."

**Naming convention**: `design-{feature}.md`. The prefix matters — it makes `grep .claude/rules/design-*.md` find every feature design.

### 4. Implementation

Ship in cuts per the implementation doc. Each cut:

- Is independently rollback-able (per [team-preferences rule 17](team-preferences.md))
- Has explicit SOLID checks (per [team-preferences rule 18](team-preferences.md))
- Updates the status table on completion
- Includes tests + docs + plan update

**Durable artifacts**: code + commit messages + status table updates.

## Grilling pattern (the operational details)

When grilling someone (or being grilled by Claude), the pattern is:

```
Q1: [structural question with three options]
    Recommend: B because [reasoning]
[user agrees / pushes back / asks for alternatives]

Q2: [next question, dependent on Q1's answer]
    ...
```

Rules:
- **One question at a time** — bundling questions loses focus
- **Always present alternatives** — at least 2-3 options per question
- **Always recommend** — never ask "what do you think?" without a position
- **Reasoning is mandatory** — not just "I prefer B" but "B because..."
- **Capture as you go** — when a term is resolved, update CONTEXT.md inline; when a decision is made, capture in the design doc

The skill that codifies this: `grill-me` and `grill-with-docs` in `~/.claude/skills/`.

## When to write an ADR

Per `~/.claude/skills/grill-with-docs/ADR-FORMAT.md`, an ADR is warranted only when ALL three are true:

1. **Hard to reverse** — meaningful cost to change later
2. **Surprising without context** — future reader will wonder "why on earth did they do it this way?"
3. **Result of a real trade-off** — there were genuine alternatives

Most decisions don't pass this bar. The design doc carries the rationale; ADRs are the durable backstop for the load-bearing few.

## Categories of work and their durable artifacts

The full picture:

| Work kind | Durable artifact |
|---|---|
| Feature design | `.claude/rules/design-{feature}.md` + `-implementation.md` |
| Architecture decision (load-bearing) | `docs/adr/NNNN-slug.md` |
| Domain language (terms, vocabulary) | `CONTEXT.md` + ADRs for load-bearing splits |
| External research / audit | `docs/audits/{topic}.md` |
| Strategic prioritization | `ROADMAP.md` |
| Strategic non-goal | `docs/non-goals.md` |
| Validated lesson / feedback | `team-preferences.md` (numbered rule) |
| Process convention | `feature-design-process.md` (this file) |
| Implementation work | code + commit messages + design-impl status update |
| Refactor / TODO | GitHub issue with full body, not a doc |
| Hygiene / one-off ops | commit message |

When a piece of work doesn't fit one of these, ask which kind it actually is. Usually it's masquerading as a different kind.

## Example: how the validation feature was designed

Reference flow that produced [`design-validation.md`](design-validation.md) + [`design-validation-implementation.md`](design-validation-implementation.md):

1. **Discovery**: realized validation was scattered (asset upload validates; render-time fail-soft; nothing else). User raised "we need altRequired enforcement."

2. **Grilling**:
   - Q1: should validation be one feature or many? → many, but with shared infrastructure
   - Q2: what types of validation do we need? → audit phase before answering
   - Q3: when does each type run? (timing) → four-phase model
   - Q4: how do we surface errors? → three surfaces, one per phase
   - Q5: cut sequence? → six cuts, low-risk-first
   - (etc.)

3. **Design**:
   - `design-validation.md` captures the four-phase model, the validator abstraction, severity model, distinctive choices
   - `design-validation-implementation.md` captures the 6-cut sequence with per-cut scope

4. **Implementation**: not yet started; will follow the cut sequence.

The whole thing was pickup-able cold by a new session because the durable artifacts captured both **what** and **why**.

## Example: how the AI alt-text feature was implemented

Reference flow that produced [`design-ai.md`](design-ai.md) + [`design-ai-implementation.md`](design-ai-implementation.md) + 9 commits of code:

1. **Discovery + grilling**: 6 design questions resolved (provider integration shape; provider choice; CI testing; prompt composition; image preprocessing; locale handling; etc.)

2. **Design**: design-ai.md + design-ai-implementation.md, both written before any code.

3. **Implementation**: 9 cuts, each on a single PR branch:
   - Cut 1: `ai/` infrastructure
   - Cut 2: AltTextAdapter + suggester contract
   - Cut 3-5: three providers (Anthropic, OpenAI, Ollama)
   - Cut 6: config + factory
   - Cut 7: admin route
   - Cut 8: UI integration
   - Cut 9: docs + plan update

4. **Validation**: smoke-tested against real local Ollama.

Status table in `design-ai-implementation.md` was updated as each cut shipped.

## What to do when you don't know what kind of work it is

If you're producing something and you don't know which durable artifact it belongs in, ask:

- "If this session ended right now, what would a future session need to pick up where I left off?"
- "Is this knowledge that survives shipping, or context that becomes stale?"
- "Does it answer 'what are we doing?' (design), 'why?' (ADR or design rationale), 'how?' (implementation), 'what's prioritized?' (ROADMAP), 'what's deliberately not?' (non-goals)?"

Usually one of the categories above is the answer. If none fits, the work might not be doc-worthy — or might warrant a new category. New categories should be deliberate; don't multiply doc kinds casually.
