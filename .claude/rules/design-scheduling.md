---
paths:
  - "packages/gazetta/src/scheduling/**"
  - "packages/gazetta/src/admin-api/routes/scheduling.ts"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "apps/admin/src/client/components/PublishPanel.vue"
  - "apps/admin/src/client/components/ArchiveModal.vue"
  - "apps/admin/src/client/components/PageMetadataEditor.vue"
  - "apps/admin/src/client/components/SchedulerPanel.vue"
  - "apps/admin/src/client/components/ScheduleChip.vue"
  - "apps/admin/src/client/components/SiteTree.vue"
  - "**/page.json"
  - "**/fragment.json"
---

# Scheduling primitive

Foundational dimension #14. Time-based state transitions for content. Single-shot actions (publish on date, archive on date, expire-approval, redirect-activate, redirect-expire); time-windowed visibility (live between dates).

Surfaced during `design-soft-delete.md`'s grilling — Q14 (redirect lifecycle) and Q12 (archive retention) both wanted scheduling. Plus existing roadmap consumers: #198 (scheduled publishing), Y4 (time-windowed visibility), `design-review-workflow.md`'s approval-expiry future direction. Single primitive, multiple consumers.

**Status**: design pass complete (2026-05). Implementation: see [`design-scheduling-implementation.md`](design-scheduling-implementation.md). Detailed UX deferred to a focused research pass before Cut 9-10 ships (per Q6 lock).

**Companion docs:**
- [`feature-design-process.md`](feature-design-process.md) — defines foundational-checks process
- [`design-soft-delete.md`](design-soft-delete.md) — Q14 + Q12 inheritance; auto-cancel-on-archive lock
- [`design-review-workflow.md`](design-review-workflow.md) — `expire-approval` action; scheduled-publish-on-approval-required-targets
- [`design-publishing.md`](design-publishing.md) — scheduled `publish` integrates with existing publish flow
- [`design-auth-rbac.md`](design-auth-rbac.md) — capability gates; capability check at fire time
- [`design-audit.md`](design-audit.md) — 5 new closed-enum action values + 2 outcome extensions
- [`design-hooks.md`](design-hooks.md) — 4 new hook phases (`beforeScheduleFire` / `afterScheduleFire` / `beforeScheduleCancel` / `afterScheduleCancel`)
- [`design-rendering.md`](design-rendering.md) — visibility window evaluated lazily at render time
- [`design-validation.md`](design-validation.md) — 6 new validators (V1-V6)
- [`design-cache.md`](design-cache.md) — standard `pages:` / `fragments:` invalidation
- [`design-offline.md`](design-offline.md) — schedule operations queue + replay; capability re-checked at replay
- [`design-collaboration.md`](design-collaboration.md) — schedule events surface in activity feeds
- [`design-scale.md`](design-scale.md) — schedule count is small (~1 per 100 pages); negligible scaling concern

## Why this is foundational

Multiple features want time-based state transitions; bolting per-feature schedule fields creates inconsistent shape. Designing the primitive once means future consumers (a future "send notification at" action; a future time-locked content feature) compose with the same mechanism — no rework.

Adding scheduling per-feature later means retrofitting:
- Background scheduler infrastructure across N consumers
- Multi-instance coordination across N consumers (each consumer would invent its own)
- Lock semantics across N consumers
- Audit shape across N consumers
- Hook composition across N consumers

The same retrofitting cost as soft-delete justified its foundational status; scheduling has the same cross-cutting profile.

## Scope

**In v1:**
- Single-shot scheduled actions on pages and fragments: `publish`, `archive`, `unarchive`, `expire-approval`, `redirect-activate`, `redirect-expire`
- Time-windowed visibility (`activeFrom` + `activeUntil`) on pages and fragments — visibility filter at render time
- Background scheduler runs in every admin instance (multi-instance correct via lock-with-TTL)
- Per-action default catch-up policy on missed windows (all v1 actions default to catch-up)
- Capability check at fire time (snapshot author + rehydrate principal); lost-capability fails permanently
- Admin UX (structural lock; detailed UX deferred): publish dialog gains schedule capability; archive modal gains schedule option; visibility window inline in metadata editor; per-page schedule chip; dedicated `/admin/scheduler` panel; site tree clock-icon indicator
- 6 validators surface schedule issues
- 5 new audit actions (closed-enum extensions)
- 4 new hook phases
- Auto-cancel on archive/rename per `design-soft-delete.md` Q6

**Reserved (v1.5+):**
- Per-locale schedules (per-page in v1; locale variants share parent's schedule)
- `comment` field on schedules (mentions integration with collaboration)
- Per-action operator-config catch-up overrides
- Per-item author-config catch-up overrides
- Schedule extension to non-state-mutating actions ("send notification at," etc.)

**Out of v1 (explicit):**
- Recurring schedules (cron-style; "every Monday at 09:00") — different consumer profile; weak demand; defer until concrete
- Server-driven catch-up for very-old schedules (>30 days late) — currently fires; threshold-based skip deferred
- Schedule chains ("after X fires, schedule Y") — different feature; defer until concrete
- Approval flows on schedule creation ("operator must approve scheduled publish") — composes with `design-review-workflow.md`'s publish-approval gate at fire time, not at create time

**Non-goals:**
- Long-running scheduled jobs (multi-hour computation) — actions are short-lived state transitions
- Distributed scheduling (cross-instance assignment by load) — single-process scheduler per instance with multi-instance coordination via lock
- Time-based content versioning ("show version A on Mondays, B on Tuesdays") — composes with future scheduling primitive but is a render-time concern
- External cron integration — Gazetta's scheduler IS the source of truth; operators don't wire external crons to call admin API

## Locked decisions

### Q1 — Scope of scheduled actions

**Locked: S4 — single-shot + window; recurring deferred.**

Two manifest field shapes:

```jsonc
// Single-shot
{
  "schedule": {
    "executeAt": "2026-11-29T06:00:00Z",
    "action": "publish" | "archive" | "unarchive" | "expire-approval" | "redirect-activate" | "redirect-expire"
  }
}

// Window (visibility-only)
{
  "schedule": {
    "activeFrom": "2026-11-29T00:00:00Z",
    "activeUntil": "2026-12-01T00:00:00Z"
  }
}
```

Action vocabulary is a closed enum; new actions need a design-pass touch to add (forward compat). Window form is shorthand for time-windowed visibility — the only consumer.

**Why S4:** real consumer demand maps to single-shot + window; recurring's consumer story is weaker. Window = pair of single-shot transitions, but visibility is a render-time predicate (no state mutation needed) so it gets the lazy-evaluation path per Q2.

### Q2 — Execution mechanism

**Locked: E3 — hybrid.**

| Action | Mechanism | Why |
|---|---|---|
| `publish` / `archive` / `unarchive` / `expire-approval` / `redirect-activate` / `redirect-expire` | **Background scheduler with sidecars** | State-mutating; needs audit, cache invalidation, hook firing — lazy-evaluation can't materialize these |
| Time-windowed visibility (`activeFrom` / `activeUntil`) | **Lazy evaluation at render time** | Pure predicate; no state change; worker checks per request |

**Background scheduler shape:**

Schedule sidecars under `.gazetta/scheduled/{action}/{ISOtimestamp}-{name}` (zero-byte; filename encodes everything). Scheduler ticks every 30s, scans next-execution window, schedules `setTimeout` for exact moments. Failure → retry per backoff; after `maxRetries` (default 3) → mark `.failed-{ts}`.

```
.gazetta/scheduled/
  publish/
    20261129T060000Z-pages.promo
    20261201T120000Z-pages.holiday
  archive/
    20261215T000000Z-pages.holiday-2026
```

Sidecars derived from manifest's `schedule` field at save time. Manifest is authoritative; sidecar is a fast-lookup index.

**Why no aggregate manifest** (e.g., `schedules.json`): per `feature-design-process.md`'s "no publish-time aggregates" principle. Per-edge sidecars scale; aggregates serialize.

**Lazy visibility evaluation shape:**

Worker reads `pages/{name}/page.json` at request time. If `schedule.activeFrom` and/or `schedule.activeUntil` set: predicate `now ∈ [activeFrom, activeUntil)` determines whether to serve content or 404.

```ts
function isVisibleNow(schedule, now = Date.now()) {
  if (schedule.activeFrom && now < new Date(schedule.activeFrom).getTime()) return false
  if (schedule.activeUntil && now >= new Date(schedule.activeUntil).getTime()) return false
  return true
}
```

No mutation; no audit; no cache invalidation; no hook firing. Pure predicate.

**Capability-gap UX (locked principle from `design-soft-delete.md` Q10):**

Time-windowed visibility on plain-static targets without a worker: capability-gap warning surfaced at four points (boot validate / author modal / scanner / publish gate). Worker is required to evaluate the predicate; plain-static can't.

### Q3 — Multi-instance coordination

**Locked: C2 — lock sidecar with TTL.**

Each scheduler tick: instance attempts to write `.gazetta/scheduled/{action}/{schedule}.lock-{instanceId}-expires-{expiresIso}` with `If-None-Match: *` (atomic conditional-create). First write wins; others see write-conflict and skip.

**Lock TTL:**

Default 5 minutes (`admin.scheduling.lockTtlMs: 300000`). Per-action defaults override (publish=5min; archive=30s). Lock holder extends mid-execution if action runs longer (e.g., 4-min publish on 5-min TTL): write a new lock with extended `expiresAt` + remove old one.

**Lazy recovery:**

When the next instance attempts to acquire and finds an existing lock: if `expiresAt < now`, remove the stale lock and write own. No background janitor process — recovery is implicit on next acquire attempt.

**`If-None-Match: *` is atomic on all four storage providers:** filesystem (POSIX `O_EXCL` flag); R2/S3 (`If-None-Match: *` HTTP header); Azure (`If-None-Match: *` header). Documented as a `StorageProvider` capability for v1.

**Multi-instance correctness invariants:**
- Exactly-one execution per fire (atomic conditional-create)
- Lazy recovery from crashed instances (no janitor)
- Idempotent retry (actions are designed to be idempotent — publish is content-addressed, archive/unarchive is field-strip last-write-wins)
- Clock skew tolerance (each instance fires per its own clock; first to acquire wins)

**Audit:**

```jsonc
{
  "action": "schedule-fire",
  "outcome": "success",
  "metadata": {
    "scheduledAction": "publish",
    "scheduledFor": "2026-11-29T06:00:00Z",
    "actualFireTime": "2026-11-29T06:00:01.234Z",
    "lateByMs": 1234,
    "instanceId": "abc123",
    "lockTtlMs": 300000
  }
}

{
  "action": "schedule-lock-recovered",
  "outcome": "success",
  "metadata": {
    "originalInstance": "xyz789",
    "originalExpiresAt": "2026-11-29T06:05:00Z",
    "expiredAgoMs": 30000,
    "scheduledAction": "publish"
  }
}
```

### Q4 — Missed-window semantics

**Locked: M3 — per-action catch-up policy.**

Per-action default policy (locked):

| Action | Default | Why |
|---|---|---|
| `publish` | catch-up | Author scheduled it; missing entirely is worse than firing late |
| `archive` | catch-up | Same |
| `unarchive` | catch-up | Same |
| `expire-approval` | catch-up | Compliance contexts NEED expiration; missing leaves stale-approval |
| `redirect-activate` | catch-up | Same |
| `redirect-expire` | catch-up | Same |

All v1 actions default to catch-up. Per-action operator override reserved (`admin.scheduling.catchUp.<action>: 'skip'`) for future actions where catch-up is wrong.

**Lateness alarm:**

Catch-up fires that are >1h late emit a structured warning log (per `design-logging.md`):

```
WARN scheduling.scheduler "Late schedule fire detected" {
  action: 'publish',
  scope: {kind: 'page', name: 'promo'},
  scheduledFor: '2026-11-29T06:00:00Z',
  lateByMs: 9015234
}
```

Threshold configurable via `admin.scheduling.lateAlertMs` (default 3600000 = 1h). Operators monitoring logs see late fires in real-time; audit log carries forensic record.

**Missed-then-fired audit:**

```jsonc
{
  "action": "schedule-fire",
  "metadata": {
    "scheduledFor": "2026-11-29T06:00:00Z",
    "actualFireTime": "2026-11-29T08:30:15.234Z",
    "lateByMs": 9015234,
    "catchUp": true
  }
}
```

`metadata.catchUp: true` distinguishes catch-up fires from on-time fires; operators monitoring "did we miss any publishes?" filter on this.

### Q5 — Action authority + capabilities

**Locked: A4 — snapshot principal at create; capability check at fire time.**

Schedule creates a per-edge actor sidecar:

```
.gazetta/scheduled/publish/
  20261129T060000Z-promo                    # the schedule trigger
  20261129T060000Z-promo.actor.json         # actor snapshot at creation time
```

Actor sidecar content:

```jsonc
{
  "id": "alice@example.com",
  "email": "alice@example.com",
  "role": "editor",
  "trustMode": "cloudflare-access",
  "capturedAt": "2026-11-15T10:00:00Z"
}
```

**Fire-time capability check:**

```ts
async function fireScheduledAction(action, scope, actor) {
  const requiredCapability = capabilityForAction(action, scope)
  const principal = await rehydratePrincipal(actor)
  if (!principal.has(requiredCapability)) {
    await audit.record({
      action: 'schedule-fire',
      outcome: 'forbidden',
      actor,
      scope,
      metadata: {
        scheduledAction: action,
        missingCapability: requiredCapability,
        principalRehydrationFailed: !principal,
        currentRole: principal?.role
      }
    })
    await markScheduleFailed(action, scope, 'forbidden')
    return  // No retry — capability failure isn't transient
  }
  await execute(action, scope, principal)
}
```

**Capability map:**

| Action | Required capability |
|---|---|
| `publish` | `publish:{target-environment}` (resolved per target at fire time) |
| `archive` | `delete:pages` / `delete:fragments` |
| `unarchive` | `edit:pages` / `edit:fragments` |
| `expire-approval` | `review:approve` |
| `redirect-activate` / `redirect-expire` | `edit:pages` / `edit:fragments` |

**Lost-capability handling:**

| Case | Behavior |
|---|---|
| Author identity gone (account deleted) | `principalRehydrationFailed: true`; capability check fails |
| Author role downgraded | `currentRole` recorded; capability check fails per current role |
| Author role upgraded | Capability check passes (admin's wildcard etc.); fires normally |
| Auth provider unreachable | Best-effort; retry per standard retry policy; after max retries → `outcome: 'forbidden'` with `metadata.rehydrationTimeout: true` |

**Operator UX for lost-capability failures:**

Admin scheduler-status panel lists failed schedules. Per row: "Author no longer has publish:non-production. [Re-attribute] [Cancel]." Operator with appropriate role can re-attribute or cancel.

### Q6 — Admin UX (structural lock; detailed UX deferred)

**Locked: structurally per surface; detailed layout/copy/icons deferred to a research pass.**

**Structural commits:**

| Surface | Commit |
|---|---|
| Schedule a publish | Existing PublishPanel gains a "Schedule for..." option alongside "Publish now" |
| Schedule an archive | Existing ArchiveModal gains a "Schedule archive" option alongside "Archive now" |
| Time-windowed visibility | Inline section in `PageMetadataEditor.vue` / `FragmentMetadataEditor.vue` (Visibility — ⊙ Always / ○ From date / ○ Between dates) |
| Edit / cancel existing schedule | Per-page schedule chip in editor toolbar (visible when item has any pending schedule) |
| Cross-site visibility | New `/admin/scheduler` route; tabs: Pending / Recent / Failed / Stuck |
| Site tree indicator | Clock icon next to scheduled-action items |
| Failed-schedule indicator | Red icon (banner) instead of clock; in editor toolbar AND tree |

**Reserved for UX research pass (~5-7 hours; lands before Cut 9-10):**
- Specific icon choices (clock variants, status colors)
- Copy / wording per surface
- Modal-by-modal interaction details (preset buttons, datetime picker shape)
- Edge-case interaction flows (schedule conflict resolution, lock-stuck recovery UI)
- Operator dashboard layout (table columns, filter shapes, bulk-action UI)

**Capability-gap UX (locked principle):** schedule modal shows per-target capability badges; archive scheduling on plain-static target without worker triggers warning at four points.

**RBAC:**

| Capability | Default roles |
|---|---|
| `schedule:create` | editor (when underlying action capability also held) + admin |
| `schedule:cancel` | editor (own schedules + items they edit) + admin |
| `read:scheduler` | admin only |

### Q7 — Validation + audit + composition

**Locked: 6 validators (V1-V6) + 5 audit actions + 2 outcomes + standard composition.**

**Validators:**

| Validator | Stage | Severity |
|---|---|---|
| V1. `schedule-conflict` (multiple schedules contradict) | save-delta + background | warn |
| V2. `schedule-action-not-supported-on-target` (capability-gap) | save-delta + background | warn |
| V3. `schedule-past-execute-time` (executeAt past at save) | save-delta | warn |
| V4. `schedule-window-inverted` (until < from) | save-delta | error |
| V5. `schedule-author-lacks-capability` | save-delta | error |
| V6. `schedule-on-archived-item-non-unarchive` | save-delta | error |

**Audit (closed-enum extensions to `design-audit.md`):**

```
action: 'schedule-create'
action: 'schedule-edit'                  // emits as cancel + create internally
action: 'schedule-cancel'
action: 'schedule-fire'
action: 'schedule-lock-recovered'
```

```
outcome: 'failed-schedule'
outcome: 'forbidden'                     // already in design-audit.md
```

**Composition:**

| Dimension | Composition |
|---|---|
| **Hooks** | 4 new phases: `beforeScheduleFire`, `afterScheduleFire`, `beforeScheduleCancel`, `afterScheduleCancel`. `before*` can throw to cancel. Existing publish/archive hooks fire alongside. |
| **Cache** | Standard `pages:` / `fragments:` invalidation on schedule operations |
| **Offline** | Schedule operations queue + replay; capability re-checked at replay |
| **Review-workflow** | Scheduled `publish` on `requiresPublishApproval: true` targets fires publish-request, not direct publish; operator must still approve |
| **Collaboration** | Schedule events surface in audit-log-derived activity feeds (when collab ships); `comment` field on schedules deferred to v2 |

### Q8 — Foundational checks

(Section below covers all 13 dimensions per `feature-design-process.md`.)

## Foundational checks

How scheduling composes with each foundational dimension plus the multi-instance discipline.

### Multi-instance discipline
- Schedule sidecars per-edge in storage; lock acquisition via atomic `If-None-Match: *`
- Lazy stale-lock recovery on next acquire (no janitor)
- Capability check per-fire; each instance does own rehydration
- Multiple instances scan independently every 30s; first to acquire fires

### Scale (#1)
- At envelope (5K pages × ~1 schedule per 100 pages = ~50 schedules) — sub-millisecond `readDir` per scheduler tick
- ISO-prefix sort by name = sort by time → range queries efficient
- Operator dashboard pagination per `design-scale.md` cursor pattern

### Locale (#2)
- Per-page schedules; locale variants share parent's schedule
- Per-locale schedules deferred (v1.5)
- `metadata.createdInTimezone` on audit events for forensic timezone context

### Themes (#3)
- Schedules don't interact with themes (action-level, not presentation-level)

### Auth + RBAC (#4)
- Capability check at fire time per Q5 (snapshot at create + rehydrate)
- 3 new capabilities: `schedule:create`, `schedule:cancel`, `read:scheduler`
- `actor.role: 'system'` for scheduler-attributed events (e.g., lock-recovered)

### Audit (#5)
- 5 new closed-enum action values + 2 outcome extensions
- `metadata.scheduledBy` on cancel events when canceler ≠ original author
- `metadata.cause: 'manual' | 'item-archived' | 'item-renamed'` for cascaded cancellations
- `metadata.catchUp: true` distinguishes catch-up fires from on-time fires

### Review (#6)
- Scheduled `publish` on `requiresPublishApproval: true` targets fires publish-request (not direct publish)
- `expire-approval` action requires `review:approve` capability
- Auto-cancel on archive (per `design-soft-delete.md` Q6)

### Hooks (#7)
- 4 new phases: `beforeScheduleFire` / `afterScheduleFire` / `beforeScheduleCancel` / `afterScheduleCancel`
- `beforeScheduleFire` can throw → audit `outcome: 'hook-cancelled'`; marked failed, no retry
- Composes with existing publish/archive hooks for the underlying action

### Render (#8)
- Time-windowed visibility evaluated lazily at request time
- Worker reads manifest's `schedule.activeFrom` / `schedule.activeUntil`; serves 404 outside window
- Per-target capability gap surfaced at four points

### Validation (#9)
- 6 new validators (V1-V6)
- Save-delta enforcement at schedule-create time (V3-V6 errors block save)
- Background scanner surfaces V1-V2 across the site

### Plugin (#10)
- No plugin-specific surfaces in v1
- Future: `ScheduleActionProvider` for custom action types
- Hook phases implementable via plugin authors

### Cache (#11)
- Standard `pages:` / `fragments:` invalidation on schedule operations
- Scheduler doesn't cache in-memory beyond per-tick
- L4+L6 cascade for cross-instance coordination

### Offline (#12)
- Schedule operations queue + replay; capability re-checked at replay
- Failed-at-replay surfaces in admin scheduler-status panel
- No special offline-specific scheduling logic

### Collaboration (#13)
- Schedule events surface in audit-log-derived activity feeds
- v1 no `comment` field on schedules; deferred

### Site config (`design-config.md`)
- `admin.scheduling.lockTtlMs` (default 300000)
- `admin.scheduling.tickIntervalMs` (default 30000)
- `admin.scheduling.maxRetries` (default 3)
- `admin.scheduling.retryBackoffMs` (default 30000 base, exponential)
- `admin.scheduling.lateAlertMs` (default 3600000)
- `admin.scheduling.failedRetention.maxAgeDays` (default 30; reserved-config)
- Future: `admin.scheduling.catchUp.<action>` per-action override (additive)

### Soft-delete (`design-soft-delete.md`)
- Auto-cancel on archive/rename per Q6 lock
- Schedules cascade-cancel during soft-delete archive operation
- Audit emits `schedule-cancel` with `metadata.cause: 'item-archived' | 'item-renamed'`
- `unarchive` action allowed on archived items; other actions refused (V6)

## Migration

Existing sites without schedule operations: continue to work. The `schedule` field is optional; absent = no scheduled actions, no visibility window, standard render path.

Existing `#198 scheduled publishing` requests: addressed by this primitive. Operators with prior cron-based scheduling migrate to manifest-level schedule fields; their existing cron jobs become redundant.

Per-instance config:
```ts
admin: {
  scheduling: {
    lockTtlMs: 300000,
    tickIntervalMs: 30000,
    maxRetries: 3,
    lateAlertMs: 3600000,
    // catchUp: { publish: 'catch-up', ... }  reserved for v1.5 per-action override
  }
}
```

## Future directions

**Recurring schedules** (Q1 deferred): cron-style "every Monday at 09:00" lands when concrete demand surfaces. Different consumer profile from single-shot.

**Per-locale schedules** (v1.5): "publish only the French variant on date X" composes with `design-i18n.md`'s locale-variant manifests.

**`comment` field on schedules** (v2): integration with `design-collaboration.md`'s mention/notification system. Allows mentioning collaborators in schedule notes.

**Per-action operator-config catch-up overrides**: `admin.scheduling.catchUp.<action>: 'skip'` for future actions where catch-up is wrong.

**Per-item author-config catch-up override**: `schedule.catchUp: false` on the manifest. Hostile UX to expose to most authors; defer until concrete demand for opt-out.

**Schedule chains** ("after X fires, schedule Y"): different feature; defer until concrete demand.

**Approval flows on schedule creation**: composes with `design-review-workflow.md`'s publish-approval gate at fire time, not at create time. The right semantic is "schedule fires the request, operator approves the request."

**Scheduled webhook firing**: composes with future `WebhookProvider` extension surface; out of v1.

**Long-running scheduled jobs**: out of scope (actions are short-lived state transitions).

**Distributed scheduling (cross-instance assignment by load)**: out of scope; single-process scheduler per instance with multi-instance coordination via lock works at envelope.

**External cron integration**: Gazetta's scheduler IS the source of truth; no API for external crons to trigger admin actions on a schedule. If operators want this, they wire their own cron to call admin API endpoints; not Gazetta's responsibility.

**`design-scheduling-ux.md` research pass**: 5-7 hours of UX research before Cut 9-10 ships. Validates structural commits in this doc against real CMS scheduling UX (WordPress, Sanity, Contentful, Storyblok, Payload, Directus). Lands detailed icon choices, modal copy, edge-case interaction flows.
