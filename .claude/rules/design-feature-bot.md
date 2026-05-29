# Feature-bot

Autonomous bot that implements feature cuts following the project's design pass. Reads cut sub-issues from GitHub; ships one PR per cut.

**Status**: design pass in progress (2026-05-30). Q1-Q4 locked; Q5-Q8 open. Implementation deferred until grilling completes.

**Companion docs**:
- [`.claude/rules/feature-design-process.md`](feature-design-process.md) — the design+implementation phases this bot operates within. **This bot's existence changes Phase 4 ("Implementation") materially — see "Process changes" below.**
- [`bots/README.md`](../../bots/README.md) — bot ecosystem context (producer/consumer rule, durable memory pattern, generator-critic loop, escalation discipline)
- [`.claude/rules/team-preferences.md`](team-preferences.md) — rules 17 (build-and-validate), 18 (build structurally right), 22 (durable artifacts), 27 (label assertion provenance), 31 (TDD-first when delegating to AI), 33 (every change goes through PR), 38 (audit symmetric bots)
- [`.claude/rules/dev-glossary.md`](dev-glossary.md) — vocabulary additions (`feature-bot`, `tracking issue`, `cut sub-issue`) land here when Q1's lock ships

## Scope

**In v1:**
- Bot reads GitHub "cut sub-issues" labeled `feature-cut` + `ready-for-agent`
- Picks the next cut whose dependencies are all closed
- Generator-critic loop (Agent A implements, Agent B reviews) — same pattern as fix-bot + dead-code-watcher
- TDD-first commit ordering per rule 31
- One PR per cut
- Durable memory: skip-list + reviewer-log (same shape as fix-bot)

**Out of v1 (deferred):**
- Cross-cut refactors (one PR touching multiple cuts)
- Cut subdivision (one cut → multiple PRs)
- Time-bound work budgets per cut (a 500-LOC cut takes as long as it takes)
- Cuts spanning multiple features

**Non-goals:**
- Implementing features without a preceding design pass (that's not feature-bot's job; design grilling happens first per `feature-design-process.md`)
- Replacing fix-bot (fix-bot handles `bug + ready-for-agent`; feature-bot handles `feature-cut + ready-for-agent` — disjoint label queues)
- Composing cut specs from prose backlog issues (the cut sub-issue's existence IS the gate that says "this work is design-passed and bot-ready")

## Locked decisions

### Q1 — Cuts live in GitHub tracking issues + sub-issues; impl docs retire

**Decision**: Cut sequencing moves from `.claude/rules/design-{feature}-implementation.md` tables to GitHub issues:

1. **Design doc** (`design-{feature}.md`) — stays in `.claude/rules/`. Durable artifact per resumability contract (rule 22). Absorbs "Deferred items" + "Lessons learned" sections that previously lived in the impl doc.
2. **Tracking issue** — labeled `feature-track` + `area: X`. Body is a tasklist of cut sub-issues. Auto-closes when all sub-issues close.
3. **Cut sub-issue** — labeled `feature-cut` + `ready-for-agent` + `area: X` + `feature: {slug}`. Body contains the per-cut spec (Q2 — format pending).
4. **Feature-bot input** — `gh issue list --label feature-cut --label ready-for-agent --state open` ordered oldest-first; pick the first whose dependency sub-issues are all closed.

The `design-{feature}-implementation.md` artifact type is **retired**. Existing impl docs migrate via one-time script (see "Migration" below).

**Why** (the load-bearing reasons that survived POV-walks across maintainer, bot, reviewer, cold-pickup, industry-precedent, producer/consumer, schema-validation, multi-feature-in-flight, GitHub-platform, and process-document POVs):

1. **Impl docs are temporary by their own design** — `feature-design-process.md` already specifies "Lifecycle of an implementation doc: pruned at ship time" — but in practice 20+ docs with pending cuts have accumulated. The artifact type doesn't fit `.claude/rules/` (current-state design + conventions).
2. **GitHub-native state machine** — sub-issue close → tracking issue tasklist auto-checks → feature progress is queryable via `gh` without parsing markdown tables.
3. **Multi-feature-in-flight clarity** — opening/closing a tracking issue is the natural "is this feature active?" flag. Solves "which of 20 docs is the bot currently working from?"
4. **PR review ergonomics** — sub-issue is the PR's spec (one-click from `Fixes #N`); reviewer doesn't need to open a separate `.md` file.
5. **Reject-without-skip-list-shape** — closing a cut sub-issue with reason is the natural "don't do this" gate; past-PR feedback loop catches it. Same mechanism fix-bot uses; no new code path.
6. **Industry precedent** — Linear, GitHub Projects v2, Rust RFCs, Kubernetes KEPs all separate the durable design (RFC / KEP / Project description) from cut tracking (sub-issues / tracking-issue tasklist). Gazetta's impl-doc was the outlier.
7. **Bot ecosystem consistency** — 5 of 7 bots already operate on GitHub issues. Feature-bot conforming reduces cognitive load and benefits from rule-38 symmetric audits with fix-bot.

**Rejected alternatives** (preserved for future-me to avoid re-litigating):

| Alternative | Why rejected |
|---|---|
| **A. Impl-doc walker** (bot reads `.claude/rules/design-{feature}-implementation.md` tables) | Status table hand-edit drift; markdown-table-as-state anti-pattern; impl docs are temporary by design but sit indefinitely in `.claude/rules/`; PR review requires opening separate file; reject-cut has no GitHub-native mechanism |
| **B. Impl-doc + GitHub issues** (hybrid; bot accepts both `☐` cut rows AND `ready-for-feature` labeled issues) | Two parsers, two validation paths; label-overlap risk with `bug + ready-for-agent`; doubles maintenance surface |
| **C. Any open issue** (bot synthesizes its own cut plan from issue body) | Violates design-first discipline (rules 22, 28, feature-design-process.md); ships features without foundational-dimension checks; blast-radius asymmetric to fix-bot |
| **D. Tracking issue + sub-issues, design doc retains impl details** | Mostly G but keeps two-place truth (cut detail in both design doc and sub-issue); chose G for single-source clarity |
| **E. GitHub Discussions per feature** | Discussions don't have label state machines; don't compose with `gh issue list` filters; sideways from bot ecosystem |
| **F. Issues for active cuts, design doc absorbs impl-doc content** | Same as G — actually this IS what G locks. (Numbering carryover from grilling session; F and G converged.) |

### Q2 — Cut sub-issue body format: just markdown

**Decision**: Cut sub-issue body is plain markdown with conventional sections. No GitHub Forms template, no YAML, no fenced data block.

Shape:

```markdown
**Feature**: redirect-ui
**Depends on**: #501, #502

## Spec

[narrative spec — links design-{feature}.md, copies the cut's intent from
the design pass; describes what to build]

## Acceptance

- [testable outcome 1]
- [testable outcome 2]
- ...
```

Bot's TS orchestrator parses two one-line key-value fields via regex:
- `**Feature**: <slug>` → picks the right design doc reference
- `**Depends on**: #N, #M` (optional) → cron-time gate; skip until all referenced sub-issues close

Everything else (`## Spec`, `## Acceptance`) is passed to Agent A as prose context. Agent A is responsible for reading the linked design doc, deciding files + tests, and writing TDD-first commits.

**Schema enforcement** lives in Agent A's prompt discipline, not at filing time:
- If `## Spec` or `## Acceptance` is missing or vague → Agent A fails loud, posts "spec incomplete" comment on the sub-issue + closes with reason. Reviewer-loop's existing escalation mechanism handles it.
- Same loud-failure semantic as fix-bot handles malformed bug reports today; existing pattern reused.

**Why** (load-bearing reasons, verified against actual practice):

1. **Match real Anthropic practice** — verified live (2026-05-30) that `anthropics/claude-code` uses markdown-with-headings for all issue bodies (`## Problem`, `## Request`, `## Precedent`); zero sub-issues; zero fenced YAML; PR bodies use the same shape (`## What`, `## How it activates`). Their issue Forms are for external user reports, not internal feature tracking. The "GitHub Forms is industry precedent" argument applies to bug/feature-request templates filled by users, NOT to internal cut tracking.
2. **Producer/consumer rule satisfied trivially** — bot's TS parses one regex (`**Depends on**: ...`); everything else is Claude's domain. Nothing brittle to maintain.
3. **Minimal moving parts** — no `.github/ISSUE_TEMPLATE/feature-cut.yml`, no Zod cut schema, no YAML emitter, no Forms-to-YAML workflow. One regex in TS.
4. **Bot ecosystem consistency** — 5 of 7 existing bots read issue bodies as prose for Claude interpretation (fix-bot, triage-bot, discovery-prep-bot, flake-watcher, mutation-watcher). Feature-bot conforms.
5. **Maintainer ergonomics across all paths** — Claude generates from design doc (90%+ of cases); maintainer hand-edits via github.com or `gh issue edit`; future contributor reads existing sub-issues and learns the pattern from examples. No filing-time forms; no YAML hand-authoring.
6. **Migration from existing impl docs is simplest** — script reads `☐ pending` cut rows; generates prose markdown bodies; posts via `gh issue create`. No template scaffolding, no YAML emission.
7. **Schema evolution costs zero** — convention evolves via example sub-issues, not via versioned schema bumps.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **A. Free-form prose, no conventions** | No `depends-on` parseable → bot can't gate on dependency completion |
| **B. Loose markdown sections (no key-value lines)** | Same as the chosen shape but without the load-bearing one-line front-matter fields; harder dep parsing |
| **C. Fenced YAML block in body** | No industry precedent for YAML in GitHub issue bodies (verified live — searched real repos); awkward synchronization between rendered prose + YAML if maintainer edits one side |
| **D. GitHub Forms template** | Industry precedent is for user-filed bug/feature-request templates, NOT internal cut tracking; adds a `.yml` schema file + a parser anchored on stable headings; over-engineered for the two fields the bot actually needs |
| **E. Forms + workflow-appended YAML hybrid** | Three moving parts (form + workflow + YAML emitter) for marginal bot-side correctness gain; documented sync-risk between rendered prose and YAML |
| **F. Front-matter YAML + prose** | YAML hand-authoring friction (mitigable via Claude Code) + no precedent for front-matter YAML in actual GitHub issue bodies (verified live — empty search) |

**Schema enforcement loss vs D/E/F**: filing-time validation of "all required fields present" is gone. Mitigated by Agent A's "fail-loud-on-vague-spec" prompt path — equivalent guarantee, simpler implementation.

**Mechanical cross-check loss vs F**: reviewer can't compare "files Agent A touched" to "files listed in YAML" because no YAML lists them. Mitigation: the cross-check was theater — the real test is rule 31's "revert the fix and the failing test still fails," which Agent B's reviewer loop runs regardless.

### Q3 — Dependency mechanism: regex-parse `**Depends on**:` with cron-tick validation

**Decision**: Cut sub-issue body declares its dependencies via a one-line front-matter field:

```markdown
**Feature**: redirect-ui
**Depends on**: #501, #502
```

Bot's TS orchestrator parses one regex per cut:

```ts
const dependsOnLine = body.match(/^\*\*Depends on\*\*:\s*(.+)$/m)?.[1] ?? ''
const depNumbers = [...dependsOnLine.matchAll(/#(\d+)/g)].map(m => Number(m[1]))
```

Tolerates `#501, #502` / `#501 #502` / `none` / empty / missing line. No deps → cut is immediately eligible.

**Validation at cron-tick (loud-fail on bad refs)**: each referenced number must be an open or closed `feature-cut` issue. On mismatch (mistyped number, non-cut issue, self-reference) the bot posts a "your sub-issue references an invalid dependency #N — check the depends-on line" comment + skips the cut. Same loud-failure pattern as fix-bot's existing input validation.

**Why** (over alternatives walked):
1. **Single source of truth.** Sub-issue body declares everything about the cut, including its position in the dependency graph. No second axis (labels, Projects, sub-issue parent/child) to keep in sync.
2. **Matches Q2's "just markdown" lock.** Dependency syntax IS markdown text; no schema, no special field.
3. **Edits natural.** Remove a dep = edit the body. Same path the maintainer already uses.
4. **Parallelizable.** Cuts with empty `Depends on` compete for bot attention; cuts with deps wait. Solves the serial-order limitation tasklist-ordering would impose.
5. **Loud-fail at cron-tick** beats silent-wait-forever on a mistyped number. Catches errors before Claude burns context.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **B. GitHub sub-issue parent/child API** | Sub-issue API has one parent-child axis only; doesn't model sibling cut→cut deps. Platform doesn't support it. |
| **C. Tracking-issue tasklist order = serial dependency** | Loses parallelizability; real impl docs have parallel cut paths (e.g., design-hooks Cuts 4/5/6 against unrelated handlers); forced serial wastes bot time. |
| **D. GitHub `Fixes`/`Closes` cross-reference syntax** | Effectively the same as A but with GitHub's bidirectional informational link decoration; doesn't gate anything; no functional difference. |
| **E. Label-per-dependency (`blocked-by:#501`)** | Label-namespace pollution (300+ labels at scale); no native "remove label X when issue Y closes" automation; would need a webhook or daily reconciliation pass. |
| **F. GitHub Projects v2 custom field** | Introduces Projects v2 dependency (`has_projects: false` in this repo); Projects v2 cards aren't tied to issue close-state the way the bot needs; over-engineered. |
| **A2 (tolerate bad refs)** | Silent-wait-forever on mistyped number; bot's job is structural correctness, malformed input should fail loud before Claude is invoked. |

### Q4 — Cut ordering: oldest-first by default, opt-in `priority:high` label override

**Decision**: Among unblocked cuts (those whose `**Depends on**` refs are all closed), the bot picks one per cron tick using two-axis sort:

```ts
const sorted = candidates.sort((a, b) => {
  const aHigh = a.labels.includes('priority:high') ? 0 : 1
  const bHigh = b.labels.includes('priority:high') ? 0 : 1
  if (aHigh !== bHigh) return aHigh - bHigh
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
  return a.number - b.number  // deterministic tiebreaker for same-second creation
})
```

**`priority:high` label** is opt-in; default is the absence of the label. Maintainer applies it when they want a specific cut to ship before older siblings (e.g., "the schema-migration cut needs to land before the dependent UI cuts even though it was filed later"). Within each tier, oldest-first prevents starvation.

**Priority does NOT bypass dependencies**: a `priority:high` cut with unsatisfied `**Depends on**:` refs still waits for its deps to close. Priority orders the eligibility queue; deps determine eligibility.

**Why** (over alternatives walked):

1. **Consistency with bot ecosystem** — fix-bot already sorts oldest-first at `bots/fix-bot/index.ts:161`. Same default; same mental model ("bots work the queue starting from the oldest").
2. **Escape hatch when intent matters** — `priority:high` is opt-in. Common case requires no thought; uncommon case requires one label flip.
3. **No new axis to maintain stale** — risk labels would drift; tasklist order would create a second source of truth competing with body-declared deps; priority is "intent right now" and doesn't need ongoing curation.
4. **Starvation-free** — within each tier, oldest-first means everything eventually ships.
5. **Matches triage-bot's pattern** — silent default + opt-in label override is precedent.

**Edge cases handled**:
- `priority:high` + blocked deps → still waits for deps.
- Same-second creation → deterministic tiebreaker by issue number ascending.
- All cuts blocked → bot exits silently with "Inbox zero" (already fix-bot's pattern).

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **A. Oldest-first only (no priority override)** | Can't express urgency; a high-priority cut filed today waits behind low-priority cuts from last week |
| **B. Risk-first (low → high via `risk:` label)** | Human risk classification famously unreliable; delays high-value high-risk cuts; adds label-curation burden; doesn't match the real maintainer question ("what should ship next?") |
| **C. Maintainer-orderable via tracking-issue tasklist** | Creates second source of truth competing with body-declared deps; extra GraphQL query per cron to fetch tasklists; sync-risk between body order and tasklist |
| **D. `priority:` label alone (no oldest-first within tier)** | Without a stable tiebreaker, two `priority:high` cuts would race; no starvation guarantee within tier |
| **F. Random selection** | Non-deterministic; hostile to maintainer prediction; trust-eroding |

## Design (high level, pending Q2)

### Bot pipeline

```
Cron (daily 04:30 UTC, after fix-bot at 04:00):
    ↓
1. Query: gh issue list --label feature-cut --label ready-for-agent --state open
    ↓
2. For each cut, check: are all deps (cut.depends-on) closed?
    ↓
3. Pick oldest unblocked cut.
    ↓
4. Generator-critic loop (max 5 attempts):
   - Agent A: write failing test commit → write fix commit → push branch
   - Agent B: review diff, vote APPROVE / REJECT / NEEDS_HUMAN
   - APPROVE → open PR; REJECT → reset + retry with reviewer note;
     NEEDS_HUMAN → close sub-issue + post-comment + skip-list entry
    ↓
5. PR opens with Fixes #<cut-sub-issue-N>. Merge closes sub-issue,
   advances tracking issue tasklist.
```

### Durable memory (per `bots/README.md` "Durable memory pattern")

| Artifact | Persistence |
|---|---|
| `bots/feature-bot/skip-list.json` | Committed; "don't re-attempt these cuts" keyed by cut sub-issue number + reason |
| `bots/feature-bot/lessons-learned.md` | Committed; cross-cut patterns (loaded into Agent A's prompt each run) |
| `bots/feature-bot/reviewer-log.jsonl` | NOT committed; persisted via `actions/cache@v4` keyed `feature-bot-reviewer-log-v1`; compactor input |

Past-PR feedback loop (existing pattern): before working on a cut, check if there's a recent PR for the same cut sub-issue number. Closed-not-merged → mine rejection reason → add to skip-list. Open → wait. Merged → no-op.

Compactor cadence: monthly `bots-compact.yml` job. Same shape as fix-bot's compactor.

### Concurrency

Workflow-level `concurrency: group: feature-bot, cancel-in-progress: false` per ADR-0011 — no two feature-bot workflows run concurrently (would race on reviewer-log cache).

## Process changes

This bot's existence changes `feature-design-process.md` Phase 4 ("Implementation"). Specifically:

**Before** (current):
- Phase 4: "Ship in cuts per the implementation doc. Each cut updates the status table on completion."
- Required artifact: `design-{feature}-implementation.md` with cut-by-cut status table.

**After** (this design's Phase 4):
- Phase 4: "Ship in cuts via tracking issue + cut sub-issues. Feature-bot picks unblocked cuts and opens PRs; maintainer reviews + merges."
- Required artifact: tracking issue (per feature) + N cut sub-issues. Deferred items + lessons learned absorbed into `design-{feature}.md` at ship time.
- `design-{feature}-implementation.md` is **retired** as an artifact type.

This is a feature-design-process-level change. Once Q2 + remaining Qs lock, the process doc needs updating in the same shipping commit as the feature-bot Cut 1.

## Migration

Existing 20+ `design-{feature}-implementation.md` files with pending cuts need migrating to tracking issues + cut sub-issues. One-time script:

1. For each impl doc with at least one `☐ pending` cut:
   - Open a tracking issue (title: "Feature: {slug}", body: tasklist placeholder)
   - For each pending cut row, open a cut sub-issue (format pending Q2)
   - Update tracking issue body to reference the cut sub-issues
2. Retire the impl doc: replace its content with a header pointing at the tracking issue, plus the "Deferred items" + "Lessons learned" sections (which migrate into the design doc).
3. `design-{feature}.md` absorbs Deferred items + Lessons learned sections.

Cuts already shipped stay as `✓ shipped` historical record in git log; not re-issued.

Mechanical, bounded one-shot. Doesn't need to be perfect — sub-issues can be edited after creation. Plan to run after Q2 locks and the bot's first cut ships (so the bot can be the first consumer of its own migration output, validating the format).

## Foundational checks (high-level — full pass after Q2 locks)

This bot operates on issues and PRs; doesn't write to the data layer. Most foundational dimensions are N/A. Brief check:

- **Multi-instance**: workflow concurrency group prevents racing. ADR-0011 pattern. ✓
- **Scale**: per-cron candidate set is small (active cut sub-issues, tens not thousands). ✓
- **Locale / Themes**: N/A (bot infrastructure, not user-facing data).
- **Auth + RBAC**: bot uses `GH_TOKEN` (Actions default) + `CLAUDE_CODE_OAUTH_TOKEN`. Same trust posture as other producer bots.
- **Audit**: bot's actions logged via GitHub audit trail (issue events, PR events, workflow runs). No `action: 'feature-cut'` audit-log event needed.
- **Review workflow** / **Hook** / **Render** / **Validation** / **Plugin** / **Cache** / **Offline** / **Collaboration**: N/A (bot doesn't traverse any of these surfaces).

## Open questions

1. **Q5 — Agent A's prompt access to design doc**: does Agent A get the full design-{feature}.md as context, or just the cut sub-issue's spec narrative? Trade-off between context completeness and context burn.
2. **Q6 — what happens when Agent A's tests for a cut depend on infrastructure from an unshipped earlier cut**: hard error (the dep is missing → spec is wrong → close cut with reason) vs. soft (skip + comment)? Pending.
3. **Q7 — escalation taxonomy**: same `escalateToHuman` shape as fix-bot? New reason codes for cut-specific failure modes (e.g., `cut-spec-too-vague`, `cut-files-conflict-with-other-cut`)?
4. **Q8 — interaction with existing impl-docs during migration**: bot tries to work an impl doc that hasn't been migrated yet — graceful skip vs. force migration? Likely "ignore non-issue impl docs; bot only sees sub-issues."

## ADR candidacy

Q1's decision (retire impl-doc artifact; cuts live in tracking issues + sub-issues) passes the three ADR criteria:

1. **Hard to reverse** — migrating 20+ impl docs is bounded but real; reversing would mean migrating sub-issues back to docs.
2. **Surprising without context** — future readers will wonder "why did the project abandon the impl-doc artifact?"
3. **Real trade-off** — POV walks documented genuine alternatives; the decision picked one for specific reasons.

ADR-0015 (next number after 0014) to land alongside this design doc when Q2 + remaining Qs lock.

## Notes

- This doc is the working artifact during grilling. As Qs lock, the "Open questions" section shrinks and the "Design" section fills in.
- Per the grill-with-docs skill, terms land in `dev-glossary.md` as they're resolved. `feature-bot`, `tracking issue`, `cut sub-issue` will be added when this design ships (along with the rename of "impl doc" to a historical term).
