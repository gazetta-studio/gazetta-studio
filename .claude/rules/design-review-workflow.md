---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "**/review*"
---

# Review workflow

Foundational dimension #6 of 13. Content review state machine + per-target publish approval. Operators with team workflows (content quality review, release management gates, compliance approvals) configure their flow per target; solo / small-team workflows bypass.

**Status**: design pass complete (2026-05). Selected as the next feature-bot candidate (2026-06-07) — it is the top committed **Phase-2** feature in [`ROADMAP.md`](../../ROADMAP.md) ("Next, this quarter") with all foundations (AuthIdentity + Audit + Hooks) shipped. The "Tier 3" status line in earlier passes was written before those foundations landed; ROADMAP is the live prioritization artifact and it places this in Phase-2. Before migration to a tracking issue + cut sub-issues, the three High-risk UX cuts (8 ReviewBanner/ReviewActions + state badges; 9 publish-approval gate; 10 per-target publish-approval UX) get a **UX-grilling pass** (Phase 2a of [`feature-design-process.md`](feature-design-process.md), which the original design pass skipped — that's *why* they're High-risk). The grilling output is **Storybook stories** (per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md)) that lock each component's states + layout + copy + `data-testid`s. The stories become the cut's executable spec; feature-bot implements components to green stories rather than inventing UX. With the UX locked in stories, all 15 cuts stay bot work.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Review check** every new feature design must answer
- [`design-auth-rbac.md`](design-auth-rbac.md) — capability vocabulary + Principal type
- [`design-audit.md`](design-audit.md) — audit log records every state transition
- [`design-collaboration.md`](design-collaboration.md) — comments / mentions / notifications layer; review-workflow v1 has narrow comment fields (reject reason); broader conversational surfaces belong in collaboration
- [`design-publishing.md`](design-publishing.md) — existing publish primitives + history-recorder
- [`design-editor-ux.md`](design-editor-ux.md) — Active target + Save semantics that review workflow gates on

## Why this is foundational

Different team workflows want different review shapes — some want content review only (editorial focus), some want publish approval only (release management focus), some want both (mid-sized teams), some want strict 4-eyes-principle (compliance). The state machine + capability composition + per-target opt-in have to support all archetypes uniformly.

Adding review later means retrofitting save/publish handlers, audit log shape, capability vocabulary, and admin UX. Joint design with auth/RBAC and audit because review uses both.

## Locked invariants

- **Per-content review** (NOT per-target). Content reviewed once; publishable to any target the actor has `publish:` capability for. Per-target deployment timing is a separate concern (per-target publish approval, optional).
- **Per-target publish approval** opt-in via `targets.{name}.requiresPublishApproval: true`. When set, publish events on that target need explicit approval beyond content review.
- **Three content review states**: `draft` → `pending-review` → `approved`. The fourth state I called "published" collapses INTO `approved` + per-target deployment timestamps from existing publish sidecars. Source-side review state vs. target-side deployment state are separate concerns.
- **Explicit-action invariant**: every state transition requires a deliberate human action recorded as an audit event. No threshold-met daemons; the click that meets the threshold writes the per-approver sidecar AND the new state in one transaction. No time-based auto-transitions.
- **Edit during pending-review is locked**: `pending-review` state denies edits with 409; author can withdraw submission (returns to `draft`) and edit. Prevents revision-DAG complexity.
- **Single reject action with mandatory comment.** No "request changes" state; comment captured in audit metadata. "Approve with caveats" is a collaboration concern (`design-collaboration.md`), not a review-state-machine concern.
- **`requiredApprovers` snapshotted at submit time.** Submission carries the policy-at-submit; subsequent config changes affect future submissions only. SOC 2-friendly (policy at decision time is documented).
- **`allowSelfApproval` defaults to `true`.** Solo / small-team archetypes (A, B) need it. Compliance archetype E opts out via `false`.
- **`invalidateOnSave` defaults to `'content-diff'`.** Only logical content changes invalidate approval. Compliance archetype E opts into `'always'`.
- **Combined "Submit & approve" button** when actor has both capabilities AND self-approval allowed AND `requiredApprovers: 1`. Audit records both events with same timestamp + same actor.
- **Pages and fragments are reviewable in v1; assets and asset-metadata defer to v2.** Asset uploads / metadata edits / site config changes / template changes bypass review at v1 (gated by their own capabilities).

## Design details

### State machine details
- Three content states (`draft` / `pending-review` / `approved`); per-content sidecar at source level
- Three publish states per publish event (when `requiresPublishApproval`): `publish-pending` / `publish-approved` / `published`
- Multi-approver counter: `requiredApprovers` per content (snapshotted at submit time); `requiredPublishApprovers` per publish event (snapshotted at request time)

### Audit event shape (extends `design-audit.md`'s `action` enum)

```ts
// Content review transitions
{ action: 'review-submit',   outcome: 'success', actor, scope }
{ action: 'review-approve',  outcome: 'success', actor, scope }                                  // metadata.comment optional
{ action: 'review-reject',   outcome: 'success', actor, scope, metadata: { comment: string } }   // comment required
{ action: 'review-withdraw', outcome: 'success', actor, scope }                                  // submitter's own action

// Per-target publish approval transitions (only when requiresPublishApproval: true)
{ action: 'publish-request',  outcome: 'success', actor, scope, metadata: { targetName: string } }
{ action: 'publish-approve',  outcome: 'success', actor, scope, metadata: { targetName: string } }
{ action: 'publish-reject',   outcome: 'success', actor, scope, metadata: { targetName: string, comment: string } }
{ action: 'publish-withdraw', outcome: 'success', actor, scope, metadata: { targetName: string } }
```

Failure outcomes (`forbidden`, `validation-failed`, `unauthenticated`) follow the standard audit shape from `design-audit.md` Q1.

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
```ts
export default defineSite({
  targets: {
    staging: {
      storage: r2Storage({ /* ... */ }),
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 1,
        allowSelfApproval: true,
        invalidateOnSave: 'content-diff',
      },
    },
    production: {
      storage: r2Storage({ /* ... */ }),
      reviewWorkflow: {
        enabled: true,
        requiredApprovers: 2,
        allowSelfApproval: false,
        invalidateOnSave: 'always',
      },
      requiresPublishApproval: true,
      requiredPublishApprovers: 1,
    },
  },
})
```

### Workflow archetypes (5 documented recipes)
- **A. Solo** — review off, publish gate off; one actor does everything
- **B. Small team — content focus** — review on, publish gate off; reviewer-as-approver
- **C. Small team — release focus** — review off, publish gate on (prod only)
- **D. Mid team — both** — review on + publish gate on (prod only); 3 distinct roles
- **E. Compliance** — review on with `requiredApprovers: 2`, `allowSelfApproval: false`, publish gate on with `requiredPublishApprovers: 2`

Each archetype gets a copy-paste-ready `site.config.ts` snippet + role mapping + capability mapping in the design doc.

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

How review workflow composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Per-edge sidecars (per-approver files at distinct paths) — concurrent approvals don't race; same pattern as asset-refs.
- State transitions write the per-approver sidecar AND the state file in one logical transaction; readers compute "is threshold met?" from `readDir` of the approvers directory. Last-write-wins on `state: approved` is idempotent (same target state regardless of which instance wrote it last).
- Snapshot of `requiredApprovers` lives in the state file at submit time; no runtime config-coordination across instances.
- Pending review queue (`/api/reviews`) reads from storage on demand per request — no shared in-memory queue.

### Scale (#1)
- Review queue paginated via prefix-shard + cursor pagination per `design-scale.md`.
- Per-content review state lookup is O(1) (`.gazetta/review/{kind}/{name}/state.json` is one file).
- Approver count check is O(N-approvers) via `readDir` (typically 1-3 approvers, never large).
- AdminCache key includes filter params; per-instance cache via `MemoryCache`.

### Locale (#2)
- Review state is on the content (the manifest). Per-locale manifests (`page.fr.json`) have their own review state — translators submit French content for review separately from default-locale content.
- Cross-locale review composition: a future "review default + auto-mark locale variants pending" mode is reserved for the per-field translation work; v1 reviews each manifest variant independently.
- RTL admin: review drawer / publish-request modal inherit document `dir` from the active locale; CSS logical properties handle the flip.

### Themes (#3)
- Theme variants don't yet exist for pages/fragments (per `design-themes.md` v1 — presentation-only). When pages gain theme variants, theme-variant manifests are reviewed independently per the locale pattern above.

### Auth + RBAC (#4)
- Capability extensions: `review:submit`, `review:approve`, `publish:request`, `publish:approve` (plus optional `publish:{target}-emergency`).
- `Principal` from auth/RBAC is the actor on every review/publish-approval audit event.
- Self-approval enforced at click-time via principal-vs-submission-actor comparison. `allowSelfApproval: false` with same actor = 403.
- Capabilities snapshot at submit time captured in audit metadata; live-evaluated at approval time.

### Audit (#5)
- Every state transition emits an audit event per the shape above.
- `action` enum extends with 8 new values (4 content-review + 4 publish-approval).
- Forensic queries answer "who approved what when, with which role at the time" via the existing `actor` snapshot from `design-audit.md` Q2.

### Hooks (#7)
- State-transition hooks (10 touchpoints listed in original stub: `beforeSubmitForReview`, `afterSubmitForReview`, `beforeApprove`, `afterApprove`, `beforeReject`, `afterReject`, `beforePublishRequest`, `afterPublishRequest`, `beforePublishApprove`, `afterPublishApprove`).
- Hook payloads carry `Principal` + content/publish-request scope.
- `before*` hooks can fail/cancel transitions; `after*` are observational.

### Render (#8)
- Review state doesn't affect render output directly. Approved content publishes as normal; pending-review content can preview but can't publish (per the publish-request gate when enabled).
- Render-time SSR with `Principal`: a future "show this only to approvers" template hint isn't in v1 review-workflow scope (would belong to RBAC capability checks at render time).

### Validation (#9)
- Validators run independently of review state. Save-delta validation runs on every save (regardless of review state); pre-publish validation runs on publish (gated by publish approval when enabled).
- A "ready for review" transition can require zero open errors on the item — composition with validation, not v1.
- Validator failures during save in `pending-review` state still return 409 + `validation-failed` audit event; review state unchanged because save was rejected.

### Plugin (#10)
- Future plugin-supplied review providers (e.g., GitHub PR-as-review) reserved per stub. v1 uses hooks for external integration; provider surface deferred until concrete demand.
- Plugin-contributed admin routes that mutate review state declare their required capabilities via the same Hono middleware contract.

### Cache (#11)
- Review queue results cached per-request by filter params; per-instance `MemoryCache`.
- Cache invalidated on every review-state-changing audit event (existing SSE invalidation infrastructure).
- Capability-scoped: cache entries scoped to role principal at cache time; role change invalidates.

### Offline (#12)
- Review submit / approve / reject queued offline + replayed on reconnect (per `design-offline.md`'s replay model).
- Replay capability check at replay time — if the principal lost `review:approve` while offline, replay fails with `outcome: 'forbidden'` recorded.
- Concurrent online approval may have already met threshold by replay time — replay sidecar write is idempotent (no-op when state is already approved); audit records the replay attempt with `metadata.replayed: true`.

### Collaboration (#13)
- Reject comment lives in audit metadata as a narrow capture; broader review discussion (inline comments, mentions to reviewers, "request changes" semantics) belongs to collaboration.
- When collaboration ships, approver behavior expands: "leave non-blocking comments on content + approve" or "reject with reason" (current path).
- Combined-action ("Submit & approve") UX stays as-is; collaboration adds the conversation layer alongside, not replacing the state machine.

## UX implementation foundation (Storybook + primitives)

Decided 2026-06-07 during the UX-grilling pass (Phase 2a, which the original design pass skipped — that's why cuts 8–10 were High-risk). Per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md), the review-workflow UI components are designed as **Storybook stories** that become feature-bot's executable spec. Two additive UI primitives are extracted first so the review components compose named, typed building blocks rather than re-deriving banner/badge markup from prose (verified extraction-cheap + additive against the shipped admin in a recon pass):

- **`<StateBadge variant color label? tooltip?>`** — extracts the dot/pill pattern duplicated verbatim across `SiteTree.vue` + `ComponentTree.vue` (dirty dot, validation dot, locale pill). **Cheap, pure-CSS DRY.** The review-state SiteTree badge (Cut 8) consumes it.
- **`<Banner severity role icon? :dismissible>` + content/actions slots** — extracts the icon+message+actions+dismiss skeleton shared by `ValidationBanner` / `ArchiveBanner` / `OfflineBanner` / `StorageQuotaBanner`. **Moderate, ~30–40 LOC, strictly additive** — the four shipped banners are **not** refactored onto it (recon confirmed migration is non-mandatory; ValidationBanner's nested issue-list resists generic slots, so leaving it inline is correct). ReviewBanner (Cut 8) is the first consumer.

**No `<ActionButton>` primitive.** PrimeVue `<Button>` is already the de-facto action-button primitive — conventions (label/icon/`size="small"`/severity/`:loading`/`data-testid`) are uniform across the admin. The review components use `<Button>` directly; stories cite its conventions.

This is *not* the design-system work deferred by [`css-theming.md`](css-theming.md): no token taxonomy, no primitive library, no refactor of shipped components. Two additive primitives, scoped to what review-workflow needs, justified by *bot-codegen reliability* (a different rationale than the visual-regression rationale that deferral addressed).

**Consequence for the cut sequence:** two foundational UI cuts prepend the UX cuts —

1. **Extract `<StateBadge>` + story** (cheap; additive; SiteTree/ComponentTree may opt in via Boy-Scout later, not required)
2. **Extract `<Banner>` + Storybook setup + story** (moderate; additive; shipped banners untouched)

— after which cuts 8–10 become compositions: ReviewBanner = `<Banner>` + `<Button>`s; ReviewActions = `<Button>` group; tree state badge = `<StateBadge>`; publish-approval gate composes the same. The cut specs become "build component X to match `X.stories.tsx`," and the bot implements to green stories. These two cuts land in the design doc's `## Cut sequence` table when the impl doc is migrated to the tracking-issue + sub-issue model.

## Migration

Targets without `reviewWorkflow.enabled` continue today's behavior (no review). Adding the flag opts in. Existing items become `draft` by default; items already published stay `published`.

## Future directions

- **Level 2 capability scoping** (per-target) — multi-stage release approval
- **Level 3 capability scoping** (per-dimension) — per-locale, per-template, per-content-type reviewers
- **Plugin-supplied review providers** — external review systems (GitHub PR-as-review). v1 uses hooks for external integration; provider surface deferred until concrete demand.
- **Approval expiry** (`requireFreshApproval` per target)
- **Notification preferences** — subscribe to review activity; lands when hooks ship
- **Multi-stage release pipelines** — QA → prod with distinct approvers per stage
