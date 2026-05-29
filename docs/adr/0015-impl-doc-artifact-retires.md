# Implementation docs retire; cuts live in GitHub tracking issues + sub-issues

> Full architectural model + foundational checks live in [`.claude/rules/design-feature-bot.md`](../../.claude/rules/design-feature-bot.md). This ADR captures the load-bearing artifact-retirement choice; the design doc captures everything else.

The `.claude/rules/design-{feature}-implementation.md` artifact type retires. The cut-by-cut implementation tracking it carried moves into GitHub: one **tracking issue** per active feature (labeled `enhancement` + `area: X`, body is a tasklist) and N **cut sub-issues** under it (labeled `enhancement` + `ready-for-agent` + `area: X`, body is just-markdown with `**Feature**:` + `**Depends on**:` front-matter lines plus `## Spec` + `## Acceptance` sections).

The `design-{feature}.md` doc — which remains the durable design artifact in `.claude/rules/` — gains a `## Cut sequence` section: a declarative table (`#, What, Depends on, Test tier, Risk`) with no status column. Intent lives in the design doc; operational state lives in GitHub sub-issue close-state.

We picked GitHub-native tracking over file-system tracking because the existing impl-doc design already specified "pruned at ship time" in `feature-design-process.md` — but in practice 20+ docs with pending cuts accumulated in `.claude/rules/`, never pruned. The artifact type didn't fit `.claude/rules/` (current-state design + conventions) and the prune-at-ship rule wasn't holding. Moving cut tracking to GitHub solves both: state machine is queryable via `gh issue list`; closing PRs auto-progresses tracking issues; "active features" is a GitHub query, not a 20-doc visual scan.

We picked **tracking-issue + cut-sub-issue** over alternatives (impl-doc walker; mixed impl-doc + issues; any-open-issue) because the bot ecosystem already operates on issue queues (5 of 7 existing bots), the PR-references-sub-issue pattern gives reviewers one-hop context, closed sub-issues are GitHub-native "don't redo this" memory (no new skip-list shape needed), and re-prioritization is a tasklist edit rather than a versioned-file PR.

We picked **zero new GitHub labels** over inventing a `feature-cut` / `feature-track` / per-feature label namespace because the existing `enhancement` + `ready-for-agent` + `area: X` vocabulary is already disjoint from fix-bot's `bug + ready-for-agent` queue and from discovery-prep-bot's `enhancement` lacking `ready-for-agent` queue. Disambiguation is structural via existing label semantics; no namespace pollution.

We picked **just-markdown sub-issue bodies** (no GitHub Forms template, no YAML, no fenced data block) over structured alternatives because verified live (2026-05-30) that Anthropic's own `claude-code` repo uses markdown-with-headings for all issue bodies and PRs — zero sub-issues, zero fenced YAML. Their GitHub Forms templates are for external user-filed issues, not internal cut tracking. The "Forms is industry precedent" argument applied to bug/feature-request templates filed by users, NOT to internal feature work.

We picked **cut-sequence section in design doc, no status column** over alternatives (generated-at-filing-time / tracking-issue-only / sync-back-from-issues) because the cut sequence is itself a design decision worth grilling (ordering, deps, test tier, risk gradient), and separating declarative intent (design doc) from operational state (GitHub) eliminates the two-place-truth drift that broke the impl doc.

## Consequences

The artifact set per feature is now: `design-{feature}.md` (durable; includes Cut sequence section, Deferred items absorbed at ship time, Lessons learned absorbed at ship time) + GitHub tracking issue + N cut sub-issues + ADRs for load-bearing decisions. The `design-{feature}-implementation.md` artifact type no longer exists.

Existing 20+ impl docs in `.claude/rules/` need migrating. Migration is **maintainer-driven via Claude Code chat**, not automated — Claude reads the impl doc, generates tracking + sub-issue bodies, posts via `gh issue create`. No flag day; impl docs migrate per-feature at maintainer's pace. Un-migrated impl docs are invisible to feature-bot (which only reads GitHub).

Cuts that already shipped under the old impl-doc model stay as git-log history (per the original prune-at-ship convention). Only `☐ pending` cuts become sub-issues during migration. The "Deferred items" and "Lessons learned" sections of impl docs move into their respective `design-{feature}.md` files.

`feature-design-process.md` Phase 4 ("Implementation") is rewritten to reference the new tracking-issue + cut-sub-issue model. The grilling protocol gains a final Q ("Cut sequence: ordering, deps, test tier, risk per cut?") that produces the design doc's Cut sequence section.

Feature-bot (the implementation of this ADR's load-bearing decision) needs maintainer-driven bootstrap. Cuts 1-6 of feature-bot's own implementation (skeleton, parser, generator-critic loop, workflow, process-doc rewrite, this ADR) ship maintainer-implemented via Claude Code. From Cut 7 onward (first real impl-doc migration), feature-bot can self-host.

Reversing this decision would require migrating sub-issues back to markdown tables — bounded but real cost. The ADR criteria (hard to reverse, surprising without context, real trade-off) are all met.

A future contributor reading a closed sub-issue won't see the corresponding PR's diff context unless they click through; the design doc's cut sequence + the closed tracking issue together carry the post-ship story. Git log per-cut is the implementation record.

If GitHub Issues becomes unavailable for an extended period (rare; the same dependency every bot already has), feature-bot can't operate. The design doc remains a complete artifact for human implementation; the cut sequence section is implementable directly without bot involvement.

`needs-info` label's semantic widens from "need information from the issue reporter" (existing triage-bot usage) to "need information from EITHER the reporter OR the maintainer." The comment thread carries specifics; the label gates the queue uniformly. One-line edit to `bots/README.md`.

Skip-list reason enum in `bots/feature-bot/skip-list.ts` extends fix-bot's existing enum with 4 feature-bot-specific values (`missing-prereq`, `spec-too-vague`, `input-cycles-exceeded`, `files-conflict`). Internal bot data structure; not labels; no namespace impact.

Cuts are independently rollback-able (rule 17): each ships as one PR; merge or revert is per-cut.

Per-feature progress is queryable two ways: GitHub (`gh issue list --search "is:open feature-track is:open"`) and the design doc (`grep -A100 "## Cut sequence" .claude/rules/design-{feature}.md`). The first answers "what's still open?"; the second answers "what was the planned decomposition?"

When a new foundational dimension lands (e.g., scheduling), all existing design docs gain a row in their Foundational checks section. Existing cut sequences may need a new cut to satisfy the dimension; this is a design-doc edit followed by a new sub-issue.

The ROADMAP's "active features" view is now `gh issue list --label enhancement --state open --no-label ready-for-human --no-label needs-info` (filtering to in-flight items) plus the design doc's cut sequence for shipping-soon visibility.
