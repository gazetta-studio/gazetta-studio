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
| `.claude/rules/design-{feature}-reference.md` | Optional: fact-checked tooling specifics, library versions, citations | Optional — used when ≥ 5 external claims need version/licensing/citation; below that, inline citations in the design doc are clearer (see media-v1 for an example that warranted it) |
| `docs/adr/NNNN-slug.md` | Architecture Decision Record | Optional — only when the decision passes the three ADR criteria (hard to reverse, surprising without context, real trade-off) |

**Required sections in a `design-{feature}.md`:**

- **Scope** — what's in v1.X, what's out, what's a non-goal
- **Companion docs** — link to implementation + reference + ADRs
- **Design model / architecture** — the actual structure
- **Distinctive choices** — what we picked vs. what we rejected, with reasons. Future-you re-litigates without these.
- **Foundational checks** — answer each of the 8 gates (Scale / Theme / Locale / Team / Hook / Render / Validation / Plugin) — see "Foundational dimensions" below
- **Migration** — for existing sites if applicable
- **Open questions** — known unresolved items
- **Future directions** — placed at the end. Lists deferred capabilities, v1.5/v2 bets, and frontier ideas that aren't committed work. Above-the-section content is the current shipped/being-built model; below-the-section content is preserved thinking, not a promise. As versions ship, items rotate up into committed scope.

**Cross-referencing convention:**

- The "Companion docs" block (placed after "Scope") lists the impl doc, reference doc (if it exists), and any ADRs that sit under this feature. Format: `- [name](relative-path) — one-line description`. Tells a cold reader which docs travel together.
- Cross-feature references in body prose use relative paths (e.g., `[design-ai.md](design-ai.md)`, not the full project-relative path). Inline at point-of-use; no bottom-of-doc "Related" section — body links stay correct as long as the body is correct, without a parallel index to maintain.

**Keeping design docs aligned with reality:**

When an implementation cut diverges from its design, the design doc is updated in the same commit as the diverging code. Two paths, both made at PR review (never deferred):

- **Design was wrong** — fix the design doc to reflect the better approach. Call out the change in the commit message.
- **Cut deviated for tactical reasons** — the design stays correct; the deviation goes into a "Current code alignment" subsection of the design doc, which becomes a punch list to reconcile or accept later (`design-publishing.md` is the reference example).

This extends [team-preferences rule 8](team-preferences.md) ("update docs in the same commit as the feature") from user-facing docs to internal design docs. Drift is a bug, caught at PR review; not a long-term decay problem to audit later.

**CONTEXT.md update trigger:**

Per the `grill-with-docs` skill (`~/.claude/skills/grill-with-docs/SKILL.md`), terms land in `CONTEXT.md` inline as they're resolved during grilling — captured when they crystallise, not batched. The filter is "meaningful to a domain expert" (Page, Fragment, Active Target — yes; `ComponentManifest`, `ResolveContext` — no, those are implementation type names, not domain language). Follow the skill's rule rather than layering a project-specific convention on top.

Renaming or removing a glossary term is itself an ADR — rename is by definition hard-to-reverse + surprising-without-context.

**Required sections in a `design-{feature}-implementation.md`:**

- **Status legend** (✓ shipped · ◐ in progress · ☐ pending)
- **Status table** — one row per cut with: cut number, what, effort estimate, dependencies, status
- **Per-cut scope** — files added/modified, tests, risk, what it doesn't catch yet
- **Deferred items** — what's out of THIS feature scope; trigger to revisit
- **SOLID checks per cut** — explicit; not implicit

The status table updates as cuts ship. When the feature is fully shipped, the implementation doc is pruned — see "Lifecycle of an implementation doc" below.

**Naming convention**: `design-{feature}.md`. The prefix matters — it makes `grep .claude/rules/design-*.md` find every feature design.

Two predecessor docs use the `-plan.md` suffix (`seo-plan.md`, `testing-plan.md`) and fuse design + implementation into one file. They migrate to the `design-{feature}.md` + `design-{feature}-implementation.md` split when the feature is next touched — splitting them cold without active context risks a bad split. Until then they stay as-is and remain auto-loaded via their `paths:` frontmatter. (`i18n-plan.md` was migrated to `design-i18n.md` in 2026-05 as part of the foundational-dimensions inventory; the design/implementation split happens when per-field translation #192 lands.)

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

## Where decisions live

Two tiers, per `~/.claude/skills/grill-with-docs/ADR-FORMAT.md`:

- **Feature-scoped decisions** → "Distinctive choices" section in `design-{feature}.md`. The bulk of design rationale.
- **Load-bearing decisions** → `docs/adr/NNNN-slug.md`. Reserved for the few that pass the ADR criteria.

ADRs are warranted only when ALL three are true:

1. **Hard to reverse** — meaningful cost to change later
2. **Surprising without context** — future reader will wonder "why on earth did they do it this way?"
3. **Result of a real trade-off** — there were genuine alternatives

The skill's `ADR-FORMAT.md` lists what qualifies in concrete terms (architectural shape, technology lock-in, boundary decisions, deliberate deviations from the obvious path, constraints not visible in code, rejected alternatives where the rejection is non-obvious). Refer to it when deciding.

Most decisions don't pass this bar. The design doc carries the rationale; ADRs are the durable backstop for the load-bearing few.

**Legacy:** `design-decisions.md` (18 entries) predates this two-tier model. Treat it like the `-plan.md` predecessors — lazy migration when a relevant feature is next touched: entries either move to that feature's "Distinctive choices" section or get promoted to ADRs. No new entries land in `design-decisions.md`.

## Foundational dimensions

Eight cross-cutting concerns that every feature design must respect. Each has its own design pass (some shipped, some pending) and corresponds to a check in the "Foundational checks" section of every new `design-{feature}.md`.

The dimensions are foundational because designing a feature without respecting them is structurally expensive to retrofit later — same principle as locale, themes, validation. These are the "must be right from the beginning" concerns.

| Dimension | Design doc | Gate | What every feature answers |
|---|---|---|---|
| Scale | `design-scale.md` | **Scale check** | Does this feature work at the documented operating envelope (target N pages / M assets / K components-per-page)? If not, what's the limitation? |
| Themes | `design-themes.md` | **Theme check** | Does this respect the closed dimension set (locale + theme) and the locked locale-priority cross-dimension fallback? If pages/fragments aren't theme-variant yet but this feature will need them, what's today's contract vs. later? |
| Locale (i18n) | `design-i18n.md` | **Locale check** | Does this respect locale as a closed dimension peer to theme? Does it use file-suffix locale variants (existing whole-file model) or layered overlays (per-field, future)? RTL coverage? |
| RBAC + audit + review | `design-rbac-audit-review.md` | **Team check** | How does this feature gate on roles? What does it record to audit log? Does it interact with review workflow state? |
| Hooks | `design-hooks.md` | **Hook check** | When does this primitive fire hooks? With what payload? Synchronous (can fail/cancel) or async? |
| Rendering modes | `design-rendering.md` | **Render check** | Which rendering modes does this support (static / ESI / request-SSR / island)? What's the limitation for unsupported modes? Does it expose render-time queries (listings)? |
| Validation | `design-validation.md` | **Validation check** | Does this feature need a Validator? When does it run (save-delta / background / pre-publish / cli)? What severity? |
| Plugin / extensibility | `design-plugins.md` | **Plugin check** | Does this surface follow the plugin lifecycle (discovery, loading, composition)? If not an extension surface, N/A |

**Status of design passes (sequenced, per current ROADMAP Tier 2):**

1. Validation Cut 1 (in flight; locks Validator/Issue contract)
2. `design-scale.md` (pending — gates every UI/API design)
3. `design-i18n.md` (migrated from `i18n-plan.md` 2026-05; design/implementation split lands with #192)
4. `design-themes.md` (pending — small, additive on i18n)
5. `design-rbac-audit-review.md` (pending — unblocks hooks, presence)
6. `design-rendering.md` (pending — depends on locale + themes)
7. `design-hooks.md` (pending — depends on RBAC)
8. `design-plugins.md` (pending — depends on hooks)

A feature design started before its required dimension's design pass has shipped MUST document the assumption it's making about the pending dimension's contract — flagged as a retrofit risk. The "Foundational checks" section captures these.

## Non-foundational disciplines

Two narrower invariants that compose with implementation work but don't rise to dimension level. They get one-line discipline notes in this doc, not full design passes:

- **MCP schema discipline** — new admin-API routes must use the existing Zod schema pattern under `packages/gazetta/src/admin-api/schemas/`. MCP tooling auto-generates from these — non-typed routes break MCP. Applies to every new route, not just MCP-aware features.
- **Real-time event-source discipline** — save and publish handlers record write events to audit log (covered by `design-rbac-audit-review.md`). Real-time push (presence, live publish status, validation push) is a separate observer layer on top of audit log — never bolted into save/publish handlers directly.

## Issue-classification discipline

Every GitHub issue (bug or enhancement) is classified into a ROADMAP bucket at file time:

- **Tier 1** (committed, 4-8 weeks)
- **Tier 2** (planned, next quarter — including foundational design passes)
- **Tier 3** (strategic bet — needs design pass before scoping)
- **Deferred** (real gap, no current trigger)
- **Non-goal** (per `docs/non-goals.md`)
- **Close** (already covered, won't ship, or duplicate)

Unclassified issues are a bug in the process. The retroactive sweep that established this discipline is documented in ROADMAP.md; going forward, every new issue's body should reference its bucket.

## Lifecycle of an implementation doc

`design-{feature}-implementation.md` is a working document. It carries cut-by-cut detail, status, file lists, and per-cut SOLID notes — useful while the feature is being built, noise once it ships.

**Trigger**: the same commit that ships the last cut also prunes the doc. The ship is the prune. No "we'll clean it up later" — that doesn't happen.

**What the prune removes:**
- Cut-by-cut status table (git log is the source of truth for cut history)
- Per-cut scope sections (files added, tests written, risk notes)
- Foundation grilling notes that have been absorbed into the design doc
- Any "in progress" or "pending" annotations

**What the prune keeps:**
- A header line: "{Feature} v1 shipped {date}; see [`design-{feature}.md`](design-{feature}.md) for the durable design."
- **Deferred items** — what was scoped out of this version, with triggers to revisit. This survives because v1.5/v2 planning needs it.
- **Lessons learned** — non-obvious things the implementation surfaced that the design doc didn't predict. Survives so the next feature design pass can avoid the same surprises.
- **Open implementation questions** that are still open after ship (rare; usually they're answered or moved to deferred).

**Why prune at ship time, not later:**

| Option | Why we don't do it |
|---|---|
| Leave doc as historical record | Implementation docs accumulate; `grep design-*.md` returns shipped detail mixed with active design. The signal-to-noise ratio decays. |
| Move to `archive/` folder | Adds a navigation step ("is this active or archived?") for every doc in the design corpus. Not worth it for a small repo. |
| Defer cleanup to a follow-up | Doesn't happen. The shipping commit is the only moment when the author has the full context to do this well. |

**The design doc (`design-{feature}.md`) is not pruned.** It carries the durable model, distinctive choices, and rationale for the shipped feature. Future readers go there to understand what the feature is and why; they go to git log to understand how it was built cut-by-cut.

**Example**: when media v1 fully ships, `design-media-implementation.md` will be pruned to ~30 lines: a header pointing at `design-media.md`, the existing "out of v1" deferred-items table, the "adjacent capabilities reserved for v1.5/v2" section, and a small lessons-learned section. The 11-row status table, the foundation grilling notes, and the per-cut detail all go away — they're recoverable from git log against the `media-v1-slice` branch.

## Versioning a design doc

`design-{feature}.md` describes the version that's currently shipped or being built. When a successor version is designed:

- **Extension (v1.5 adds capabilities to v1)**: edit `design-{feature}.md` in place. Items from "Future directions" rotate up into committed scope; the design doc absorbs the new capabilities. The implementation doc for the v1.5 work is a fresh `design-{feature}-implementation.md` (the v1 one was pruned at v1 ship time).
- **Supersession (v2 diverges meaningfully from v1)**: fork the doc. Rename the v1 design to `design-{feature}-v1.md` with a header pointing at the new `design-{feature}.md`. The new file describes v2 from a clean slate. Rare — most version bumps are extensions.

The choice between extension and supersession is a judgment call made when v2 grilling starts, not predicated on a rule. If you're not sure, default to extension — superseded docs are noise unless v1 and v2 genuinely tell different stories.

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
