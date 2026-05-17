# Code review splits into Discovery and Evaluation phases as separate skill families

> Full design lives in [`.claude/rules/design-code-review.md`](../../.claude/rules/design-code-review.md). Phased implementation in [`.claude/rules/design-code-review-implementation.md`](../../.claude/rules/design-code-review-implementation.md). Companion ADR [`0012-skill-three-invocation-modes.md`](0012-skill-three-invocation-modes.md) covers the load-bearing decision about Skill scope. This ADR captures the load-bearing decision about how code review is structured; the design doc captures everything else.

Code review in this project is two distinct skill families with different input shapes, different output schemas, and different consumers:

- **Discovery — `audit-area` skill.** Input: one or more paths. Output: a JSONL `candidates` fence listing ranked improvement candidates, each with an `area`, `type`, `severity`, `summary`, `suggested_action`, and `rule` citation. Answers the forward-looking question: "what's worth changing in this area?"
- **Evaluation — `review-orchestrator` skill + 6 angle skills (`review-diff`, `review-architecture`, `review-security`, `review-tests`, `review-types`, `review-comments`).** Input: a diff. Output: a JSONL `findings` fence listing issues in the diff, each with a `severity`, `file`, `line`, `category`, `rule`, `message`, `suggestion`, and `confidence`. Answers the backward-looking question: "is this proposed diff good?"

The two families share infrastructure (severity model, decision-log convention, finding/candidate schema shape, rule-citation pattern) but ship as separate skills with distinct invocation contracts.

We picked this over collapsing both phases into a single skill family with a mode flag (`audit-area` becomes a mode of `review-orchestrator`) because the two phases ask different questions and produce different outputs. Mode-flagged skills mean every angle skill's body has to handle both "find candidates in this area" and "evaluate this diff." That's two judgment shapes in one prompt — the skill body either becomes mode-conditional (effectively two skills in one file) or splits the difference and does both jobs mediocrely. Anthropic's `pr-review-toolkit` plugin doesn't have this split because it doesn't have a discovery use case; our autonomous `review-bot` requires discovery (Phase 0 picks an area; Phase 1 asks "what to improve here?") before evaluation can run. Separating the families honors what each skill is actually for.

We picked two families over a single mega-skill (`code-review` with all six angles and discovery folded together) because mega-skills are the Anthropic-documented anti-pattern for SKILL.md design ([Nimbalyst, 2026 guide](https://nimbalyst.com/blog/claude-code-skills-guide/) explicitly calls out the "mega-skill" failure mode). Six angles each get their own SKILL.md so each can be invoked individually (`/review-security` alone) and each can load only the docs relevant to its angle. The orchestrator + angle split is the canonical Anthropic pattern from the `pr-review-toolkit` plugin (6 sub-agents + one `/review-pr` slash command); we mirror it.

We picked separate `audit-area` over reusing `review-orchestrator` with a `--paths` flag because the orchestrator's job is fan-out + aggregate over a diff; folding "no diff, look at code as-is" into that pipeline would mean the orchestrator runs the same six angles with degraded behavior (angles tuned for diff review would have to handle "no diff" as a special case). The discovery output schema is also legitimately different from evaluation: candidates carry a `suggested_action` field (Agent A's starting point) that findings don't; findings carry a `line` field that candidates don't (candidates are area-scoped, not line-scoped). Two schemas, two skills.

We picked one discovery skill (`audit-area`) over per-angle discovery skills (`audit-security`, `audit-architecture`, etc.) because discovery is by nature cross-cutting — the question "what's worth changing in this area?" doesn't pre-select an angle, and forcing the user (or review-bot) to pick an angle before discovery defeats the discovery purpose. `audit-area` accepts an optional `focus` hint (e.g., `focus: security`) for callers who do want to narrow; this provides the per-angle behavior as an opt-in without splitting the family.

We picked one orchestrator (`review-orchestrator`) over a "smart angle" model where each angle decides whether to run because the dispatch decision (which angles fire on this diff?) is producer work (deterministic path-glob matching) per `bots/README.md`'s producer/consumer rule. Centralizing dispatch in one TypeScript file (`dispatch.ts`) and one orchestrator skill keeps the angles focused on judgment.

## Consequences

The skill family lives at `.claude/skills/`:

- `audit-area/SKILL.md` — Phase 1 Discovery
- `review-orchestrator/SKILL.md` + `dispatch.ts` — Phase 2 Evaluation orchestrator
- `review-{diff,architecture,security,tests,types,comments}/SKILL.md` — Phase 2 angle skills

Eight skill files total. Each is independently invokable interactively (`/<name>`), headlessly (bot orchestrator → `claude -p`), or as a sub-agent (parent Claude session → `Agent` tool). Per ADR-0012, the broadened Skill definition supports all three modes from one SKILL.md.

The autonomous `review-bot` (per the design's P4 cuts) composes both families: Phase 0 (TS-side area scoring + LLM area pick) → Phase 1 (`audit-area`) → Phase 2 (`review-orchestrator` as Agent B in a generator-critic loop). This is the only consumer that uses both families in one workflow.

Other consumers use only one family:
- **Local CLI** `/review-orchestrator` and `/review-{angle}` are Phase 2; `/audit-area` is Phase 1
- **PR-comment trigger** `@claude review` is Phase 2; `@claude audit <path>` is Phase 1
- **Fix-bot reviewer** uses Phase 2 only (specifically `review-architecture` + `review-security` as sub-agents replacing the existing project-rule check)

The dispatch table inside `review-orchestrator/SKILL.md` maps diff paths to angle skills. The table is documented in prose for readability + implemented in `dispatch.ts` for execution. Per ADR-0012's "what work belongs in the skill body vs the invoking orchestrator," the dispatch is producer work (deterministic glob matching against the diff) — TS code does it, not the LLM. Angles fire in parallel via single-message multi-`Agent` invocations.

Aggregation across angle outputs happens in the orchestrator skill body (post-fan-out): group by `(file, line, category)`, keep max severity per group, drop confidence < 80, sort by severity rank then file path. The aggregator is the orchestrator's job because it has the fan-out context; angles individually don't know about each other's findings.

Future Phase 1 use cases (e.g., a `bulk-audit` CLI command for non-interactive whole-area sweeps) are additive — they invoke `audit-area` programmatically. Future Phase 2 use cases (e.g., review-on-push without comment trigger) are also additive — they invoke `review-orchestrator` with a different diff source.

A future "code-simplifier"-style refactor skill family or a "silent-failure-hunter" specialized angle slots in as either (a) a new angle skill added to the Phase 2 family + dispatch table row, or (b) a new family entirely if the use case doesn't fit "evaluate a diff" or "find candidates in an area." The two-family split sets the precedent: skill families are partitioned by question shape (forward vs backward looking, candidate vs finding output), not by topic.

If a future use case surfaces that genuinely requires fusing discovery + evaluation (e.g., "look at this area AND propose a diff AND review it in one skill"), this ADR is the place to re-litigate. The candidate alternatives — single-mode-flagged skill, hierarchical orchestrator that decides phase per invocation — were considered and rejected for v1 because no concrete use case required them. Operator-facing review uses one phase at a time; review-bot's pipeline composes phases via the orchestrator (TS), not within a skill.

Migration cost is zero — this is new infrastructure. The existing `/review-prs` slash-command skill (project-local, walks the open-PR queue) is unchanged; it's a different shape than either Phase 1 or Phase 2 (it's an interactive queue-walker, not a one-shot reviewer). The existing Anthropic `pr-review-toolkit` plugin is unchanged; users can install both — project-level skills (`.claude/skills/review-*`) coexist with the global plugin's namespaced commands (`/pr-review-toolkit:review-pr`).
