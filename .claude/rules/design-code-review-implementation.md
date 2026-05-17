---
paths:
  - ".claude/skills/audit-area/**"
  - ".claude/skills/review-orchestrator/**"
  - ".claude/skills/review-diff/**"
  - ".claude/skills/review-architecture/**"
  - ".claude/skills/review-security/**"
  - ".claude/skills/review-tests/**"
  - ".claude/skills/review-types/**"
  - ".claude/skills/review-comments/**"
  - "bots/review-bot/**"
  - ".github/workflows/review-on-comment.yml"
  - ".github/workflows/review-bot.yml"
  - "bots/fix-bot/prompts/reviewer.md"
---

# Code Review — Implementation

Companion to [`design-code-review.md`](design-code-review.md). Phased cut sequence with risk ordering.

See `design-code-review.md` for the design itself and the two ADRs ([0012](../../docs/adr/0012-skill-three-invocation-modes.md), [0013](../../docs/adr/0013-code-review-two-phase-model.md)) for the load-bearing decisions.

## Phased build

Four phases, each independently shippable. Risk increases per phase; each phase validates assumptions for the next.

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

| Phase | What | Risk | Validates |
|---|---|---|---|
| **P1** | Skill family (6 angles + orchestrator + audit-area + dispatch.ts + glossary updates + ADRs) | Medium | The skill contract works in isolation; angles produce useful findings; dispatch table fits real diffs |
| **P2** | Fix-bot reviewer integration | Medium | Skills compose as sub-agents from another Claude session; severity-to-action mapping works in a bot context |
| **P3** | PR-comment trigger workflow | Low-medium | Comment-driven invocation works; reaction emoji feedback; output formatting on a real PR thread |
| **P4** | Review-bot (autonomous) | High | Phase 0/1/2 composition; skip-list correctness; cross-run dedup at candidate level; full producer-bot pattern |

## Cut sequence — P1: Skill family

Sequenced contract-first (output format, severity model), then orchestrator scaffolding, then the easier angles, then the harder angles last. Each cut is independently rollback-able.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | ADRs (0012, 0013) + glossary updates (Review angle, Findings fence, Severity, Generator-critic loop, Skip-list) | ☐ | Low | Vocabulary + load-bearing decisions captured |
| 2 | `review-orchestrator/SKILL.md` (skeleton) + `dispatch.ts` + vitest tests | ☐ | Medium | Dispatch shape; producer/consumer split; parallel sub-agent invocation pattern |
| 3 | `review-diff/SKILL.md` (general baseline — the simplest angle) | ☐ | Low | Output format + finding shape against a real diff |
| 4 | `review-comments/SKILL.md` (next-simplest — pure judgment, narrow scope) | ☐ | Low | Empty-fence behavior on diffs that don't touch comments |
| 5 | `review-types/SKILL.md` (Zod-schema-aware) | ☐ | Medium | Type-introspection pattern (find `z.object`, `interface`, `type` in diff) |
| 6 | `review-tests/SKILL.md` (TDD-ordering + static tautology + tier shape) | ☐ | Medium-high | Static check that doesn't duplicate fix-bot's runtime check |
| 7 | `review-architecture/SKILL.md` (foundational dimensions; hybrid context load) | ☐ | High | Per-area design-doc loading; doesn't burn context; cites rules correctly |
| 8 | `review-security/SKILL.md` (SSRF/capability/sanitization/secrets) | ☐ | High | Security-specific path + content patterns; CRITICAL severity assignment correctness |
| 9 | `audit-area/SKILL.md` (Phase 1 discovery) | ☐ | Medium-high | Candidates fence schema; multi-angle internal lens application |
| 10 | E2E: local CLI invocation of all 8 skills against a real synthetic diff; manual verification | ☐ | Low | Skill family works end-to-end before P2 integration |

### Per-cut scope

#### Cut 1: ADRs + glossary

**Files added:**
- `docs/adr/0012-skill-three-invocation-modes.md` — captures the broadened Skill definition + alternatives + rationale
- `docs/adr/0013-code-review-two-phase-model.md` — captures audit-area-vs-review-orchestrator split + alternatives + rationale

**Files modified:**
- `.claude/rules/dev-glossary.md` — `Skill` entry already broadened (in this design pass); add 5 new entries: Review angle, Findings fence, Severity, Generator-critic loop, Skip-list. Place after the existing Bots and skills section.

**Tests:** none (docs only).

**Why first:** vocabulary precedes implementation. Subsequent cuts cite glossary terms; ADRs are referenced by SKILL.md bodies.

**SOLID:** N/A — documentation.

#### Cut 2: review-orchestrator skeleton + dispatch.ts

**Files added:**
- `.claude/skills/review-orchestrator/SKILL.md`
  - YAML frontmatter (name, description, allowed-tools, argument-hint)
  - Prose body: dispatch table (documented), aggregation rules, output format
  - Calls `dispatch.ts` via Bash; reads line-separated angle list; spawns sub-agents (Agent tool) in parallel
- `.claude/skills/review-orchestrator/dispatch.ts`
  - Reads `git diff --name-only $BASE...$HEAD` (or arg-provided path list)
  - Pattern-matches against the dispatch table from the design doc
  - Emits one angle name per line on stdout
- `.claude/skills/review-orchestrator/tests/dispatch.test.ts`
  - Unit tests: each path pattern correctly selects expected angles
  - Edge case: empty diff (returns just `review-diff`); all-paths diff (returns all 6)

**Tests:**
- Vitest unit tests against `dispatch.ts` covering each row of the dispatch table.
- One integration test: invoke `dispatch.ts` against a known git diff fixture.

**Stubs (no angle skills exist yet):** the orchestrator SKILL.md is written but invoking it returns an error message ("angle skills not yet present"). Validates the dispatch shape without depending on cuts 3-9.

**Why now:** orchestrator's contract drives angle skill design. Lock the shape first.

**SOLID:** SRP — dispatch.ts owns path-classification; SKILL.md owns prompt + sub-agent orchestration. OCP — adding new angles = adding rows to dispatch table + adding an angle SKILL.md.

#### Cut 3: review-diff/SKILL.md

**Files added:**
- `.claude/skills/review-diff/SKILL.md`
  - YAML frontmatter
  - Reads CLAUDE.md + relevant team-preferences.md rules (the "always-load" baseline per the hybrid context strategy)
  - Looks for: logic bugs, null/undef handling, race conditions, CLAUDE.md violations, basic style issues
  - Emits prose + findings fence per the locked schema

**Tests:**
- Manual verification against 3 sample diffs (good code; subtle bug; obvious bug). Document expected findings in a `tests/fixtures/` directory.

**Why third:** simplest angle. Establishes the SKILL.md template pattern that cuts 4-9 mirror.

#### Cut 4: review-comments/SKILL.md

**Files added:**
- `.claude/skills/review-comments/SKILL.md`
  - Reads CLAUDE.md (the "no comments unless WHY is non-obvious" rule)
  - Looks for: comment-rot (comment says X, code does Y), redundant comments (restates code), missing context, misleading examples

**Tests:**
- Manual verification against fixture diffs with mixed comment changes.

**Why now:** narrow scope, low risk. Locks the empty-fence behavior in real use.

#### Cut 5: review-types/SKILL.md

**Files added:**
- `.claude/skills/review-types/SKILL.md`
  - Detects `z.object(...)`, `interface`, `type` in the diff
  - Applies the type-design-analyzer pattern from the upstream toolkit: encapsulation / invariant expression / usefulness / enforcement
  - Tuned for Zod-schema-driven types + capability interfaces

**Tests:** manual against fixture diffs adding new types.

**Why now:** type-introspection in the diff is a different pattern than diff-line-reading. Validates a sub-pattern before the harder cuts.

#### Cut 6: review-tests/SKILL.md

**Files added:**
- `.claude/skills/review-tests/SKILL.md`
  - Reads team-preferences.md rules 26 (test isolation), 31 (TDD-first / tautology), `testing-plan.md` (tier shape)
  - Static checks:
    - TDD-ordering: when diff includes `test:` commit before `fix:` commit, signal good ordering; reverse signals concern
    - Tautology static: does the test's assertion reference behavior that wouldn't fire without the implementation? Heuristic only.
    - Tier shape: is this a unit test in a sub-system that's pyramid-shaped (core)? Honeycomb-shaped (admin-api)? Mismatch warrants finding.
    - Isolation: module-level `tempDir(name)` without per-test suffix; module-level mutable state shared across tests
  - Light mutation-viability heuristic only; defer to mutation-watcher for full check

**Tests:** manual against fixture diffs with various test patterns.

**Why now:** higher risk because of overlap with fix-bot's runtime tautology check. Cut must NOT duplicate the runtime check; only static + judgment.

#### Cut 7: review-architecture/SKILL.md

**Files added:**
- `.claude/skills/review-architecture/SKILL.md`
  - Always loads: CLAUDE.md + dev-glossary.md + the 13-foundational-dimensions list (extract or summarize from feature-design-process.md)
  - On-demand loads: per-area design-*.md per a documented mapping table:
    - `packages/gazetta/src/audit/` → `design-audit.md`
    - `packages/gazetta/src/validation/` → `design-validation.md`
    - `packages/gazetta/src/hooks/` → `design-hooks.md`
    - `packages/gazetta/src/auth/` → `design-auth-rbac.md`
    - `packages/gazetta/src/review/` → `design-review-workflow.md`
    - `packages/gazetta/src/scheduling/` → `design-scheduling.md`
    - `packages/gazetta/src/soft-delete/` → `design-soft-delete.md`
    - `.claude/rules/design-*.md` (modification to design doc itself) → that doc
    - `docs/adr/` → the modified ADR
  - Max 2 docs read per invocation (context budget). Document the order of preference.
  - Findings cite `rule: <doc-name>.md[#anchor]`

**Tests:** manual against fixture diffs touching specific foundational areas.

**Why now:** highest-risk single skill; on-demand context loading is novel and must be tested in real use before audit-area depends on it.

#### Cut 8: review-security/SKILL.md

**Files added:**
- `.claude/skills/review-security/SKILL.md`
  - Reads `design-auth-rbac.md` always (security baseline)
  - Path-conditional reads: `design-media.md` (when assets/sanitize touched), `design-validation.md` (when validators touched)
  - Looks for: missing capability gates, RBAC bypass, SSRF (URL fetching without allowlist), injection (unsanitized HTML/SVG/SQL), secret leakage (env vars in logs, token in error messages), dependency vulnerabilities (only when `package.json` changed)
  - Heavy on CRITICAL severity assignment — security findings dominate the CRITICAL category

**Tests:** manual against fixture diffs with deliberate security issues (capability missing, SSRF, secret in log).

**Why now:** highest-risk because severity assignment matters most here (false negative = security bug ships; false positive = annoying but recoverable). Done after cut 7 because the foundational-dimensions pattern is now proven.

#### Cut 9: audit-area/SKILL.md

**Files added:**
- `.claude/skills/audit-area/SKILL.md`
  - Phase 1 discovery skill
  - Input: path or paths + optional focus hint
  - Internally applies the angle lenses but in candidate-ranking mode, not finding-emission mode
  - Output: prose + JSONL candidates fence per the locked schema

**Tests:** manual against 3 areas with known issues (a security-weak area, an under-tested area, an architecturally-coherent area expecting empty candidates).

**Why last:** depends on the angle skills being well-shaped (since audit-area internally borrows their lenses). Land after the angles are working.

#### Cut 10: E2E manual verification

**Files added:**
- `.claude/skills/tests/e2e/` (or similar) — fixture diffs + expected behaviors documented

**Tests:**
- Manual invocation of each `/review-{angle}`, `/review-orchestrator`, `/audit-area` against fixture cases
- Verify: dispatch table picks correct angles; aggregation dedups correctly; severity assignment matches schema rules; rule citations land in `rule` field

**Why last in P1:** validates the family works before P2 starts integrating it.

## Cut sequence — P2: Fix-bot reviewer integration

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 11 | Update `bots/fix-bot/prompts/reviewer.md` — replace Step 3 (project-rule check) with `review-architecture` invocation; add Step 3b (`review-security` if security-sensitive paths) | ☐ | High | Skills work as sub-agents from a headless Claude bot; severity-to-verdict mapping correct |
| 12 | Run replay against past fix-bot reviewer runs (`npm run replay -w @gazetta/bots fix-bot <past-run-id>`) | ☐ | Medium | New reviewer prompt doesn't regress past good verdicts |
| 13 | Ship in production (cron daily) — monitor first 5-10 reviews | ☐ | Medium | Real-world signal; tune confidence/severity if FP rate too high |

### Per-cut scope

#### Cut 11: Reviewer prompt update

**Files modified:**
- `bots/fix-bot/prompts/reviewer.md` — replace "Step 3: project-rule check" section with skill invocation; add "Step 3b: security review on sensitive paths" section. Document action policy table (CRITICAL → REJECT/NEEDS_HUMAN; IMPORTANT → REJECT with Note; NIT → mention).

**Tests:**
- Vitest tests in `bots/fix-bot/tests/` (existing test infra) that mock skill outputs and verify the reviewer's verdict logic responds correctly per the table.

**SOLID:** SRP — reviewer prompt orchestrates checks; skills own their judgment. DIP — reviewer depends on skill output contract (JSONL fence), not skill internals.

#### Cut 12: Replay against past runs

**Files modified:** none (replay is a tooling operation).

**Process:**
```bash
gh run list --workflow=fix-bot.yml --limit 20
# Pick 5-10 past runs with diverse verdicts (APPROVE, REJECT, NEEDS_HUMAN)
npm run replay -w @gazetta/bots fix-bot <run-id>
# Diff replay transcript vs original
# Document differences; tune prompt if necessary
```

**Acceptance criterion:** past APPROVEs stay APPROVE (no false REJECTs); past REJECTs either stay REJECT or convert to NEEDS_HUMAN (acceptable); no past REJECT silently becomes APPROVE.

#### Cut 13: Production monitoring

**Files modified:** none (operational).

**Monitoring:** for the first 5-10 fix-bot reviewer runs after Cut 11 lands, manually inspect the transcripts + outcome:
- Did the right skills fire?
- Were findings actionable?
- Did Agent A's retries address the new Note format?

Tune dispatch table or severity thresholds if FP rate measurable.

## Cut sequence — P3: PR-comment trigger workflow

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 14 | `.github/workflows/review-on-comment.yml` listening to `issue_comment` event on PRs | ☐ | Medium | Workflow shape; comment-grammar parser; reaction-emoji feedback |
| 15 | Bot wrapper script that invokes the orchestrator skill headlessly and posts results | ☐ | Medium | Headless `claude -p` invocation of the orchestrator skill; output formatting |
| 16 | E2E test on a real PR | ☐ | Low | Full workflow under real GitHub Actions conditions |

### Per-cut scope

#### Cut 14: Workflow file

**Files added:**
- `.github/workflows/review-on-comment.yml`
  - Trigger: `on: issue_comment: types: [created]`
  - Filter: `if: github.event.issue.pull_request != null && contains(github.event.comment.body, '@claude review') || contains(github.event.comment.body, '@claude audit')`
  - Permissions: `pull-requests: write`, `actions: read`, `contents: read`
  - Steps:
    1. Add 👀 reaction to comment
    2. Parse comment for grammar: `@claude review [angle...]` or `@claude audit <path>`
    3. Invoke bot wrapper script with parsed args
    4. On success: add ✅ reaction; on failure: add ❌
  - Concurrency group: `review-on-comment-pr-${{ github.event.issue.number }}` (cancel-in-progress: false)

**Tests:** manual workflow_dispatch invocation against a known PR.

#### Cut 15: Bot wrapper

**Files added:**
- `bots/review-on-comment/index.ts` (or similar; could live under `bots/` per existing patterns OR be inline in the workflow)
  - Parses comment grammar
  - Constructs the diff input (`gh pr diff <N>`)
  - Invokes `claude -p` with the review-orchestrator skill + the diff payload
  - Parses orchestrator stdout for the `findings` fence
  - Renders to GitHub markdown
  - Posts ONE PR comment with the rendered findings + outcome tag `<!-- review-on-comment: run=$RUN_ID -->`
  - Inline comments on CRITICAL findings (via `gh pr comment` or `gh api`)

**Tests:** vitest tests against mocked skill output + mocked GitHub API.

#### Cut 16: E2E

Manual verification against a real test PR. Validate the comment posts, reactions update, dispatch works, formatting reads well.

## Cut sequence — P4: Review-bot

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 17 | `bots/review-bot/` scaffolding (`index.ts`, `prompts/agent-a.md`, `skip-list.{ts,json}`, `lessons-learned.md`, `past-pr.ts`, `compact.ts`, `reviewer-log.ts`) — mirror dead-code-watcher | ☐ | Medium | Bot infrastructure follows established pattern |
| 18 | Phase 0 implementation: TS area-scorer + LLM area-picker | ☐ | High | Hybrid producer-consumer split for area selection; skip-list-aware |
| 19 | Phase 1+2+3+4+5 integration: orchestrate audit-area → top candidate → Agent A → Agent B (review-orchestrator) → verdict → PR | ☐ | High | Full producer-bot pattern with generator-critic loop |
| 20 | `.github/workflows/review-bot.yml` cron + concurrency group | ☐ | Low | Workflow runs daily; doesn't conflict with fix-bot |
| 21 | First 5 production runs monitored; tune Phase 0 scoring + Phase 1 candidate ranking | ☐ | Medium | Real-world quality signal |
| 22 | Compactor integration: add `bots-compact.yml` job for review-bot (monthly lessons-learned rewrite) | ☐ | Low | Long-term memory health |

### Per-cut scope

#### Cut 17: Scaffolding

**Files added:**
- `bots/review-bot/index.ts` — orchestrator entry point
- `bots/review-bot/prompts/agent-a.md` — generic "implement this candidate" prompt
- `bots/review-bot/skip-list.ts` + `skip-list.json` — durable memory schema
- `bots/review-bot/lessons-learned.md` — initial empty
- `bots/review-bot/past-pr.ts` — Past-PR feedback loop (mirror dead-code-watcher)
- `bots/review-bot/compact.ts` — compactor entry (used by bots-compact.yml job)
- `bots/review-bot/reviewer-log.ts` — JSONL append helper for cache-persisted reviewer log
- `bots/review-bot/tests/` — vitest tests for the per-bot helpers

**Tests:** vitest tests for skip-list reader/writer, past-pr classifier, candidate-fingerprint generator.

#### Cut 18: Phase 0 (area scoring + LLM pick)

**Files added/modified:**
- `bots/review-bot/area-scorer.ts` — TS-side area scoring:
  - Read `git log --since='30 days ago' --name-only --pretty=format:''` to identify recently-touched areas
  - Filter out areas with active or recently-closed review-bot PRs (skip-list-aware)
  - Score by: recency × directory-size × time-since-last-touched-by-review-bot
  - Return top 5 candidate areas + per-area one-line context
- `bots/review-bot/prompts/area-picker.md` — small prompt: "here are 5 candidate areas with context; pick one with reasoning"

**Tests:** vitest tests for area-scorer scoring function with mocked git log.

**Risk:** scoring function is heuristic; may pick boring areas. Cut 21 will tune.

#### Cut 19: Full pipeline

**Files modified:**
- `bots/review-bot/index.ts` — wire phases together:
  ```
  1. Phase 0: area-scorer.ts → top 5 → area-picker prompt → 1 picked area
  2. Phase 1: invoke audit-area skill on the area → parse candidates fence
  3. Phase 2: sort candidates by (severity, confidence); skip skip-listed; pick top
  4. Phase 3: invoke agent-a.md with picked candidate → Agent A makes commits on improve/<id> branch
  5. Phase 4: invoke review-orchestrator on the diff (as sub-agent) → parse aggregated findings
  6. Phase 5: verdict per action policy → APPROVE pushes branch + opens PR; REJECT resets + retries (MAX_ATTEMPTS=5); NEEDS_HUMAN logs + skip-list entry
  ```

**Tests:** vitest tests with fully mocked skill outputs validating each phase's transition logic.

**Risk:** highest in this phase. Composes multiple LLM calls in series; failure at any phase needs graceful handling.

#### Cut 20: Workflow

**Files added:**
- `.github/workflows/review-bot.yml`
  ```yaml
  on:
    schedule:
      - cron: '30 04 * * *'    # daily 04:30 UTC
    workflow_dispatch:
  concurrency:
    group: review-bot
    cancel-in-progress: false
  ```
- Cache setup for `bots/review-bot/reviewer-log.jsonl` (key: `review-bot-reviewer-log-v1`)

**Tests:** manual `workflow_dispatch` invocation.

#### Cut 21: Production tuning

**Files modified:** as needed based on first 5 runs.

**Process:** monitor first runs, check transcripts, validate:
- Did Phase 0 pick areas worth improving?
- Did audit-area surface real candidates (not just nits)?
- Did Agent A produce reasonable PRs?
- Did Agent B reviewer catch issues correctly?

Tune scoring weights, dispatch table, severity thresholds based on signal.

#### Cut 22: Compactor

**Files modified:**
- `.github/workflows/bots-compact.yml` — add a `review-bot` job mirroring the dead-code-watcher pattern: lessons-learned rewrite + reviewer-log prune
- `bots/review-bot/compact.ts` — compactor logic (already scaffolded in Cut 17; finalize in this cut)

**Tests:** vitest tests for compaction logic.

## What's deferred from this plan

| Item | Trigger to revisit |
|---|---|
| `--paths` mode on Phase 2 evaluation skills | Concrete demand for non-diff Phase 2 review |
| Cross-run "still present / resolved" annotation in local CLI | Developer feedback: "I keep forgetting which findings I already addressed" |
| Per-finding stable fingerprint | When cross-run state becomes necessary |
| Operator-extensible angle skills via plugin pattern | 3+ operators want a custom review angle |
| Severity-promotion config per consumer | Concrete demand for "production-touching paths should treat IMPORTANT as REJECT" |
| `@claude review --reply <hash>` PR-comment grammar (replay vs previous comment) | Workflow polish; v1 ships fresh-each-invocation |
| In-place comment editing (workflow polish for PR comments) | PR-comment thread feels noisy in real use |
| Edit-in-place GitHub PR comment instead of new comment per invocation | Same trigger as above |
| `silent-failure-hunter` promoted to own angle | Error-handling findings recur frequently in `review-diff` |
| `code-simplifier`-style refactor skill family | Proactive simplification becomes a workflow need |
| Skill-level mutation-viability check beyond light heuristic | Tighter integration with mutation-watcher's data |
| Bulk-audit CLI (`gazetta audit packages/gazetta/src/auth/`) | Non-interactive Phase 1 invocation outside Claude session |
| Confidence calibration / false-positive tracking | After 100+ skill invocations, periodic review of FP rate per category |
| Edit-in-place review comments on PRs (replace prior) | Workflow polish; multi-invocation noise |
| Cross-language guides bundled (React/Vue/Rust/etc. like `awesome-skills/code-review-skill`) | When this project gains code in those languages, or operators want pluggable language angles |

## Open implementation questions

1. **Dispatch table fidelity.** First 10-20 invocations will surface paths the initial table misses (e.g., Zod schemas inside admin client code). Plan: extend the table additively; never remove rows without justification.

2. **`review-architecture`'s context budget at 5K-page scale.** The always-load (CLAUDE.md + dev-glossary.md + dimension list) is bounded. The on-demand per-area design-*.md loads are bounded by the "max 2 docs per invocation" rule. Validate that this stays in Claude's context comfortably in real use.

3. **Replay-loop coverage for skill changes.** Currently the replay infrastructure (per `bots/README.md`) is per-bot. Skill changes affect multiple bots; replaying across all consumers of a changed skill is manual. Consider extending `npm run replay` to support skill-level replay against multiple bot histories.

4. **Sub-agent output capture from `Agent` tool.** When the orchestrator skill spawns angle skills via Agent, the result is the final message. Multi-angle parallel spawns return multiple results; the orchestrator must parse each for its `findings` fence. Tested in Cut 2 via fixture; revisit if Agent tool behavior changes.

5. **PR-comment workflow rate limiting.** GitHub Actions has per-repo concurrency limits. The workflow's concurrency group is per-PR (`review-on-comment-pr-{N}`) so high-volume PRs don't queue forever, but cross-PR concurrent invocations could saturate. Monitor in Cut 16.

6. **Review-bot's "no candidates found" outcome.** If Phase 0 picks an area and Phase 1 returns no candidates ≥80 confidence, the bot exits silently. Add a skip-list entry for that area? Just log? Decision in Cut 19.

7. **Mid-pipeline failure recovery in review-bot.** Agent A pushes commits then fails partway through Phase 4; the branch exists in a half-state. Recovery: reset branch, log as NEEDS_HUMAN, move on. Verify in Cut 19.

8. **Skill ordering deterministic vs LLM-stable.** Aggregator's sort (severity → file path) is deterministic. But the prose-above-fence varies per invocation. For reproducibility (replay loop diffs), the findings fence ordering matters; the prose doesn't. Validate the fence is stable across replays.

## Estimates

Wall-clock for solo dev with budget for review iteration:

| Phase | Cuts | Estimate |
|---|---|---|
| P1 | Cuts 1-10 | 8-12 days |
| P2 | Cuts 11-13 | 2-3 days |
| P3 | Cuts 14-16 | 3-4 days |
| P4 | Cuts 17-22 | 6-8 days |

**Total: ~3-4 weeks** solo. Budget 1.5× for first-time-doing-this-pattern adjustments.

## SOLID checks per cut

Validated at design time:

- **Cut 1**: N/A (docs only)
- **Cut 2**: SRP — dispatch.ts owns classification; SKILL.md owns orchestration. OCP — adding new angles = additive rows + new SKILL.md. DIP — orchestrator depends on the Skill contract (JSONL fence), not on individual angle implementations.
- **Cuts 3-9**: Each angle is its own SKILL.md; SRP per angle. LSP — every angle's output conforms to the same JSONL findings fence schema. ISP — each angle only reads the docs relevant to its angle (not all design-*.md).
- **Cut 11**: SRP — reviewer prompt orchestrates checks; skills own judgment. DIP — reviewer depends on skill output contract, not skill internals.
- **Cuts 14-16**: SRP — workflow handles trigger + reaction + dispatch; wrapper handles invocation + parsing + posting; skill handles judgment. Three distinct concerns, three artifacts.
- **Cuts 17-22**: SRP — each phase has its own module (area-scorer.ts, past-pr.ts, compact.ts, etc.). Same pattern as dead-code-watcher (validated working).

Any cut failing SOLID review at PR time is a structural correction (rule 18), not a patch.

## Migration

None — new infrastructure. Existing tooling continues to work:

- Existing `/review-prs` slash-command skill: unchanged
- Existing fix-bot reviewer: modified per Cut 11 only
- Existing dead-code-watcher reviewer: unchanged
- Global pr-review-toolkit plugin (`~/.claude/plugins/...`): unchanged; users can install both

## Why this shape

**Phased so each phase is independently valuable.** P1 alone (the skill family) gives local-CLI users + future bots a working tool. P2 adds fix-bot quality lift. P3 adds PR-comment-driven review. P4 adds autonomous review-bot.

**Producer/consumer rule respected at every layer.** Dispatch is TS (producer); skills do judgment (consumer); orchestrator aggregates JSONL (producer); each consumer applies action policy (consumer-local).

**Risk increases per phase.** P1's per-cut order moves from simplest angle (review-diff) to hardest (review-architecture, review-security, audit-area). P4 is highest-risk overall because it composes multiple LLM calls in series; lands last after P1/P2/P3 have validated the skill contract.

**Generator-critic pattern reuses established infrastructure.** Review-bot mirrors dead-code-watcher + fix-bot's pattern; no new bot architecture to design. Validated by ADR-0011's cache-persistence contract + the existing `_lib/` shared helpers.

**Two ADRs for two truly load-bearing decisions.** Broadened Skill definition + two-phase model are both hard-to-reverse + surprising-without-context + result of real trade-offs. Other decisions live as "Distinctive choices" in the design doc.
