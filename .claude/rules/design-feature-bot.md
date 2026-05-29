# Feature-bot

Autonomous bot that implements feature cuts following the project's design pass. Reads cut sub-issues from GitHub; ships one PR per cut.

**Status**: design pass in progress (2026-05-30). Q1 locked; Q2 open. Implementation deferred until grilling completes.

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

### Q2 — Cut sub-issue body format

**Status**: OPEN. The grilling session walked five alternatives (A prose-only, B loose markdown sections, C fenced YAML in body, D GitHub Forms, E Forms + workflow-appended YAML, F front-matter YAML + prose) and converged through four flips. Final unconfident-state: between D (industry precedent, matches Kubernetes / Anthropic / Linear / Rust) and F (bot-friendliest structured input, no industry precedent for YAML-in-issue-body).

**Open question for next grilling pass**: validate by building a thin slice. Per rule 17 ("build and validate, don't spike"), the right next step is to ship the smallest end-to-end path with one format, see what real bot ergonomics push back, and only flip if needed.

**Likely starting point**: D (GitHub Forms). Has actual issue-body precedent (verified live against Kubernetes' `enhancement.yaml` template, Anthropic claude-code's `feature_request.yml`, Rust's tracking-issue template). The "brittle regex parser" concern from the producer/consumer rule is mitigable through:
- Schema-stable headings (generated by GitHub Forms, not by Claude or a filer)
- Explicit `if (section === '')` checks that fail loud rather than silently
- Parser tests against the rendered template output

**Migration risk if D turns out wrong**: additive. Adding fenced YAML to existing sub-issue bodies is a one-time script pass; doesn't require rewriting feature-bot.

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

1. **Q2 — cut sub-issue body format**: D (GitHub Forms) likely starting point per "build and validate" discipline; F (front-matter YAML) is the structured-bot-input alternative if D's parser becomes the actual problem. Validate by building thin slice.
2. **Q3 — dependency mechanism**: `depends-on: [#501, #502]` in the sub-issue body? Native GitHub sub-issue references? Issue type labels? Pending grilling after Q2 locks.
3. **Q4 — cut ordering when multiple are unblocked**: oldest-first? Risk-first? Maintainer-prioritizable via label? Pending.
4. **Q5 — Agent A's prompt access to design doc**: does Agent A get the full design-{feature}.md as context, or just the cut sub-issue's spec narrative? Trade-off between context completeness and context burn.
5. **Q6 — what happens when Agent A's tests for a cut depend on infrastructure from an unshipped earlier cut**: hard error (the dep is missing → spec is wrong → close cut with reason) vs. soft (skip + comment)? Pending.
6. **Q7 — escalation taxonomy**: same `escalateToHuman` shape as fix-bot? New reason codes for cut-specific failure modes (e.g., `cut-spec-too-vague`, `cut-files-conflict-with-other-cut`)?
7. **Q8 — interaction with existing impl-docs during migration**: bot tries to work an impl doc that hasn't been migrated yet — graceful skip vs. force migration? Likely "ignore non-issue impl docs; bot only sees sub-issues."

## ADR candidacy

Q1's decision (retire impl-doc artifact; cuts live in tracking issues + sub-issues) passes the three ADR criteria:

1. **Hard to reverse** — migrating 20+ impl docs is bounded but real; reversing would mean migrating sub-issues back to docs.
2. **Surprising without context** — future readers will wonder "why did the project abandon the impl-doc artifact?"
3. **Real trade-off** — POV walks documented genuine alternatives; the decision picked one for specific reasons.

ADR-0015 (next number after 0014) to land alongside this design doc when Q2 + remaining Qs lock.

## Notes

- This doc is the working artifact during grilling. As Qs lock, the "Open questions" section shrinks and the "Design" section fills in.
- Per the grill-with-docs skill, terms land in `dev-glossary.md` as they're resolved. `feature-bot`, `tracking issue`, `cut sub-issue` will be added when this design ships (along with the rename of "impl doc" to a historical term).
