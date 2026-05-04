---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "**/review*"
---

# Review workflow

Foundational dimension #6 of 12. Content review state machine + per-target publish approval. Operators with team workflows (content quality review, release management gates, compliance approvals) configure their flow per target; solo / small-team workflows bypass.

**Status**: design pass pending — depends on `design-auth-rbac.md` (capability vocabulary + `Principal`) + `design-audit.md` (audit-event recording for every transition). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Review check** every new feature design must answer
- [`design-auth-rbac.md`](design-auth-rbac.md) — capability vocabulary + Principal type
- [`design-audit.md`](design-audit.md) — audit log records every state transition
- [`design-publishing.md`](design-publishing.md) — existing publish primitives + history-recorder
- [`design-editor-ux.md`](design-editor-ux.md) — Active target + Save semantics that review workflow gates on

## Why this is foundational

Different team workflows want different review shapes — some want content review only (editorial focus), some want publish approval only (release management focus), some want both (mid-sized teams), some want strict 4-eyes-principle (compliance). The state machine + capability composition + per-target opt-in have to support all archetypes uniformly.

Adding review later means retrofitting save/publish handlers, audit log shape, capability vocabulary, and admin UX. Joint design with auth/RBAC and audit because review uses both.

## Locked invariants (already decided)

- **Per-content review** (NOT per-target). Content reviewed once; publishable to any target the actor has `publish:` capability for. Per-target deployment timing is a separate concern (per-target publish approval, optional).
- **Per-target publish approval** opt-in via `targets.{name}.requiresPublishApproval: true`. When set, publish events on that target need explicit approval beyond content review.
- **Three content review states**: `draft` → `pending-review` → `approved`. The fourth state I called "published" collapses INTO `approved` + per-target deployment timestamps from existing publish sidecars. Source-side review state vs. target-side deployment state are separate concerns.
- **Explicit-action invariant**: every state transition requires a deliberate human action recorded as an audit event. No threshold-met daemons; the click that meets the threshold writes the per-approver sidecar AND the new state in one transaction. No time-based auto-transitions.
- **Edit during pending-review is locked**: `pending-review` state denies edits with 409; author can withdraw submission (returns to `draft`) and edit. Prevents revision-DAG complexity.

## Open questions for the design pass

### State machine details
- Three content states (`draft` / `pending-review` / `approved`) confirmed; per-content sidecar at source level
- Three publish states per publish event (when `requiresPublishApproval`): `publish-pending` / `publish-approved` / `published`
- Multi-approver counter: `requiredApprovers` per content; `requiredPublishApprovers` per publish event

### Capability additions
- `review:submit` — submit content for review
- `review:approve` — approve OR reject pending reviews
- `publish:request` — request a publish to a target
- `publish:approve` — approve a pending publish request
- Optional `publish:{target}-emergency` for hotfix bypass

### Self-approval
- Configurable via `reviewWorkflow.allowSelfApproval: boolean` (default `true`)
- When self-approval allowed AND actor has both `review:submit` + `review:approve`, UI offers combined "Submit & approve" button
- When `allowSelfApproval: false`, approver who is also the submitter gets 403 at click-time

### Re-review on save granularity
- Configurable: `reviewWorkflow.invalidateOnSave: 'content-diff' | 'always'`
- Default `'content-diff'` — only content-hash changes invalidate approval
- Strict `'always'` — every save invalidates (compliance-friendly)

### Storage shape (per-edge sidecars)
- `.gazetta/review/{kind}/{name}/state.json` — current review state + timestamps + comments
- `.gazetta/review/{kind}/{name}/approvers/{actor}` — zero-byte per-approver sidecar
- `{target-root}/.gazetta/publish-requests/{kind}/{name}/{request-id}.json` — publish request state
- `{target-root}/.gazetta/publish-requests/{kind}/{name}/{request-id}/approvers/{actor}` — zero-byte per-approver sidecar
- Per-edge granularity → multi-instance correct via the same pattern as asset-refs

### Configuration
```yaml
targets:
  staging:
    storage: { type: r2, ... }
    reviewWorkflow:
      enabled: true
      requiredApprovers: 1
      allowSelfApproval: true
      invalidateOnSave: content-diff
  production:
    storage: { type: r2, ... }
    reviewWorkflow:
      enabled: true
      requiredApprovers: 2
      allowSelfApproval: false
      invalidateOnSave: always
    requiresPublishApproval: true
    requiredPublishApprovers: 1
```

### Workflow archetypes (5 documented recipes)
- **A. Solo** — review off, publish gate off; one actor does everything
- **B. Small team — content focus** — review on, publish gate off; reviewer-as-approver
- **C. Small team — release focus** — review off, publish gate on (prod only)
- **D. Mid team — both** — review on + publish gate on (prod only); 3 distinct roles
- **E. Compliance** — review on with `requiredApprovers: 2`, `allowSelfApproval: false`, publish gate on with `requiredPublishApprovers: 2`

Each archetype gets a copy-paste-ready `site.yaml` snippet + role mapping + capability mapping in the design doc.

### Capability scoping for advanced archetypes (deferred)
- **Level 2 (per-target capability scoping)** — `review:approve@{target}`, `publish:approve@{target}`. Future when multi-stage release demand (archetype H) surfaces.
- **Level 3 (per-dimension capability scoping)** — `review:approve@{template}`, `review:approve@{locale}`. Future for editorial (archetype F) + translation (archetype G) demand.
- v1 capability format is `name:action` (no scope); forward-compatible with future scoping syntax.

### Combined-action UX
- "Submit & approve" button when actor has both capabilities AND self-approval allowed AND `requiredApprovers: 1`
- "Publish-request & approve" button when actor has both AND self-approval allowed AND `requiredPublishApprovers: 1`
- Audit records both events (submit + approve) with same timestamp + same actor

### Constructive errors
- `409 NO_APPROVER_AVAILABLE` at submit/publish-request time when no actor in configured roles has the required capability (deadlock prevention)
- 403 messages include suggested action ("Your role 'editor' doesn't have review:approve. Ask an admin to upgrade your role or contact a reviewer.")
- Site config validation at boot warns/errors on review-workflow-enabled-but-no-approvers misconfig

### Withdraw flow
- Author with active submission can withdraw → returns content to `draft`
- Audit records `action: 'review-withdraw'`
- Different from rejection (no comment required; submitter's own action)

### Concurrent approval race tolerance
- Per-approver sidecars (different paths) — no race on writes
- State-write check ("am I the Nth approver?") computes via `readDir` after writing per-approver sidecar; idempotent state writes (last-write-wins on `state: approved` is fine)
- No atomic-counter required

### Visibility filtering
- Review queue (`/api/reviews`) returns all pending items the user can READ (per coarse-grained discovery filter from `design-auth-rbac.md`)
- UI client-side filters to "actionable for you" by default; toggle for "all pending I can read"
- Approver visibility of OWN submissions: yes (need to see them to approve when self-approval allowed)

### Pending review queue at scale
- `/api/reviews?target={target}&action={pending-review|publish-pending}&cursor={cursor}` follows prefix-shard + cursor pagination from `design-scale.md`
- AdminCache key includes filter params; per-instance cache via `MemoryCache`

### Configuration changes mid-flight
- `requiredApprovers` change 1→2 mid-flight: existing pending-review entries carry their original requiredApprovers value (snapshotted at submit time); new submissions use new value
- Disabling `reviewWorkflow.enabled` mid-flight: in-flight reviews resolved by direct publish OR admin manually closes them; audit records the config change

### Hook firings (touchpoints reserved for `design-hooks.md`)
- `beforeSubmitForReview`, `afterSubmitForReview`
- `beforeApprove`, `afterApprove`
- `beforeReject`, `afterReject`
- `beforePublishRequest`, `afterPublishRequest`
- `beforePublishApprove`, `afterPublishApprove`
- `beforePublish`, `afterPublish` (existing)
- Each hook receives `Principal` + content/publish-request scope

### Source-vs-target lifecycle
- Review state is on the source manifest; per-target deployment state is independent (existing publish sidecars per `design-publishing.md`)
- UI shows both: "Approved" + "Last published to: prod (3 hrs ago), staging (5 min ago)"
- No automatic reconciliation between source-state and target-state

### `gazetta dev` impersonation for testing
- New `trust: 'dev'` mode in `design-auth-rbac.md` (locked there)
- Dev-only URL parameters: `?as=alice@test.com&roles=editor,reviewer`
- Disabled in production (`NODE_ENV !== 'production'` enforced)

### Non-content writes
- Site config changes, template changes, asset uploads bypass review at v1
- Asset metadata edits (alt text, title) bypass review at v1
- Future asset review: when concrete editorial demand surfaces

### Re-publish of approved content
- Approved content can be re-published to a target without re-review (review is on content, not on each publish)
- If `requiresPublishApproval` is on: each publish event still requires its own publish approval

### Approval expiry (future)
- Per-target `requireFreshApproval: true` rejects publishes of approvals older than N hours; forces re-submit + re-approve specifically for that target
- v2 / Tier 3; not in v1

### Right-to-be-forgotten
- `gazetta audit scrub --actor=alice@example.com` extends to scrub review sidecars (per-approver, comments)
- Free-text comments mentioning OTHER actors are NOT auto-scrubbed (documented limitation)

## Foundational checks

To be filled in when this design pass formally completes. Touchpoints to address:
- Multi-instance: per-edge sidecar pattern; multi-instance-correct
- Scale: paginated `/api/reviews` per `design-scale.md`
- Locale, themes: review state is content-level; locale variants reviewed per variant
- Team: capability composition with `design-auth-rbac.md`
- Hook: state transitions fire hooks (touchpoints listed above)
- Render, Validation, Plugin, Cache, Offline: composition deferred to design pass

## Migration

Targets without `reviewWorkflow.enabled` continue today's behavior (no review). Adding the flag opts in. Existing items become `draft` by default; items already published stay `published`.

## Future directions

- **Level 2 capability scoping** (per-target) — multi-stage release approval
- **Level 3 capability scoping** (per-dimension) — per-locale, per-template, per-content-type reviewers
- **Plugin-supplied review providers** — external review systems (GitHub PR-as-review). v1 uses hooks for external integration; provider surface deferred until concrete demand.
- **Approval expiry** (`requireFreshApproval` per target)
- **Notification preferences** — subscribe to review activity; lands when hooks ship
- **Multi-stage release pipelines** — QA → prod with distinct approvers per stage
