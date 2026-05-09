---
paths:
  - "packages/gazetta/src/scheduling/**"
  - "packages/gazetta/src/admin-api/routes/scheduling.ts"
  - "apps/admin/src/client/components/SchedulerPanel.vue"
  - "apps/admin/src/client/components/ScheduleChip.vue"
---

# Scheduling primitive — Implementation

Companion to [`design-scheduling.md`](design-scheduling.md). Cut sequence with risk ordering.

See `design-scheduling.md` for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `scheduling-v1` off `main`. **No backwards compatibility** — `schedule` manifest field is additive.

Sequenced data-shape-first (manifest + types + schemas), then engine (sidecar + scheduler + lock), then admin-API contracts, then admin UX. UX research pass (~5-7 hours) lands detailed UX between cuts 8 and 9.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | Manifest `schedule` field + Zod schemas + types | ☐ | Low | Type contract; no runtime behavior |
| 2 | `StorageProvider.writeFile` honors `If-None-Match: *` (atomic conditional-create) on all four backends | ☐ | Medium | Multi-instance lock primitive |
| 3 | Schedule sidecar mechanism: derive `.gazetta/scheduled/{action}/{ts}-{name}` from manifest's `schedule` field on save | ☐ | Medium | Sidecar lifecycle + multi-instance correctness |
| 4 | Background scheduler tick loop: scan, acquire lock with TTL, fire action, release lock | ☐ | High | The core engine |
| 5 | Per-action capability check at fire time (Q5 lock) — actor sidecar + rehydration | ☐ | Medium | Lost-capability handling |
| 6 | Lazy visibility evaluation in renderer (Q2): `isVisibleNow` predicate at render time | ☐ | Medium | Time-windowed visibility runtime path |
| 7 | Validators (V1-V6) + integration with `design-validation.md`'s Cut 1 + Cut 2 surfaces | ☐ | Low | Validation foundation integration |
| 8 | Admin-API routes: schedule create/edit/cancel/list + audit + cache invalidate | ☐ | Medium | Server contract |
| **UX research pass** | **5-7 hours; not a cut. Lands `design-scheduling-ux.md` with detailed UX before Cut 9.** | ☐ | — | Detailed UX validated against real CMS research |
| 9 | Admin UI: PublishPanel schedule option + ArchiveModal schedule option + visibility metadata section + schedule chip + tree clock indicator | ☐ | High | Visible UX |
| 10 | Dedicated `/admin/scheduler` panel (operator dashboard): Pending / Recent / Failed / Stuck tabs + bulk actions | ☐ | Medium | Operator visibility |
| 11 | CLI: `gazetta schedule list / fire / cancel / clear-stuck` (operator surface) | ☐ | Low | Operator CLI |
| 12 | E2E + docs (`docs/scheduling.md`) | ☐ | Low | User-facing |

**Total: ~22 days** wall-clock for solo dev. Budget ~4-5 weeks with iteration on cuts 4, 9 (high-risk surfaces).

## Per-cut scope

### Cut 1: Manifest fields + schemas

**Files modified:**
- `packages/gazetta/src/types.ts` — add to `PageManifest` and `FragmentManifest`:
  ```ts
  schedule?:
    | { executeAt: string; action: 'publish' | 'archive' | 'unarchive' | 'expire-approval' | 'redirect-activate' | 'redirect-expire'; targetName?: string }
    | { activeFrom?: string; activeUntil?: string }
  ```
- `packages/gazetta/src/admin-api/schemas/pages.ts` + `fragments.ts` — extend Zod schemas with the discriminated union
- `packages/gazetta/src/save-etag.ts` — include schedule fields in canonical etag

**Tests:**
- Schema parsing: discriminated union validates correctly; reject mixed forms (both `executeAt` + `activeFrom` set)
- Schema parsing: closed enum on `action`; unknown action rejected
- Type narrowing: `manifest.schedule.action === 'publish'` narrows correctly
- save-etag changes when schedule changes; stable when content unchanged + schedule same

**Risk:** low. Pure data-shape addition.

### Cut 2: `StorageProvider.writeFile` atomic conditional-create

**Files modified:**
- `packages/gazetta/src/types.ts` — `StorageProvider.writeFile(path, content, opts?: { ifNoneMatch?: '*' }): Promise<void>`. When `ifNoneMatch: '*'`, throw `StorageConditionalFailedError` if the file already exists.
- `packages/gazetta/src/providers/filesystem.ts` — use `fs.writeFile` with `flag: 'wx'` (write + exclusive)
- `packages/gazetta/src/providers/r2.ts` — use `If-None-Match: *` HTTP header
- `packages/gazetta/src/providers/s3.ts` — same
- `packages/gazetta/src/providers/azure-blob.ts` — same

**Tests:**
- Each provider: write with `ifNoneMatch: '*'` succeeds when file doesn't exist
- Each provider: write with `ifNoneMatch: '*'` throws when file exists
- Each provider: concurrent writers — only one succeeds; others throw

**Risk:** medium. Cloud provider semantics differ in edge cases; integration test against MinIO + Azurite covers v1 needs.

### Cut 3: Schedule sidecar lifecycle

**Files added:**
- `packages/gazetta/src/scheduling/sidecars.ts`:
  - `writeScheduleSidecar(storage, action, schedule, name)` — derives sidecar path from `executeAt + name`
  - `removeScheduleSidecar(storage, action, name)` — cleanup
  - `listScheduleSidecars(storage, action, sinceTimestamp)` — readDir with prefix filter
  - `writeActorSnapshot(storage, action, name, principal)` — peer file
  - `readActorSnapshot(storage, action, name)` — read peer file at fire time

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` (PUT handler) — when manifest's `schedule` field changed, derive new sidecar / remove old. Idempotent.
- `packages/gazetta/src/admin-api/routes/fragments.ts` — same

**Tests:**
- Save with new schedule → sidecar written
- Save with removed schedule → sidecar removed
- Save with edited schedule → old sidecar removed, new written
- `listScheduleSidecars` returns items in time order
- Multi-instance: two instances saving to different schedules don't race (different paths)

**Risk:** medium. Sidecar lifecycle drift is a class of bugs; tests cover happy paths, but external manifest edits (git pull) bypass the save handlers. Reindex CLI command lands in Cut 11.

### Cut 4: Background scheduler tick loop

**Files added:**
- `packages/gazetta/src/scheduling/scheduler.ts`:
  - `startScheduler(opts: { storage, instanceId, tickIntervalMs, lockTtlMs, ... }): { stop(): void }`
  - Inner: `tick()` runs every `tickIntervalMs`; reads `listScheduleSidecars`; for each due item, attempts lock acquisition; on success, `setTimeout` to fire at exact `executeAt`
  - `acquireLock(action, name, instanceId, ttlMs): string | null` — returns lock path on success, null on contention
  - `releaseLock(lockPath, schedulePath)` — removes lock + schedule sidecars
  - `extendLock(lockPath, newExpiresAt)` — for long-running actions

**Files modified:**
- `packages/gazetta/src/admin-api/index.ts` — start scheduler at admin boot; pass `instanceId` from environment
- `packages/gazetta/src/cli/index.ts` — `gazetta serve` starts scheduler too (composes with worker boot)

**Tests:**
- Single-instance: tick fires due schedules; setTimeout exact-time semantics within ~10ms
- Multi-instance: two instances scan same schedule simultaneously; only one acquires lock; other skips
- Stale-lock recovery: lock expires → next acquire removes stale lock + writes own
- Lock extension: long-running action extends lock periodically without contention
- Action failure: retries per backoff; after maxRetries → `.failed-{ts}` marker

**Risk:** high. The core engine. Property-test the lock semantics with random concurrent-instance simulations.

**SOLID:** SRP — sidecar I/O in `sidecars.ts`; lock semantics + tick loop in `scheduler.ts`; action execution dispatched to existing handlers (publish, archive, etc.). DIP — scheduler doesn't know how to publish; calls into existing publish handler.

### Cut 5: Capability check at fire time

**Files modified:**
- `packages/gazetta/src/scheduling/scheduler.ts` — before firing, read actor sidecar; rehydrate principal via auth provider; check capability; on mismatch → audit `outcome: 'forbidden'` + mark failed
- `packages/gazetta/src/auth/principal.ts` — add `rehydratePrincipal(actor: ActorSnapshot): Promise<Principal | null>` (returns null if user gone)

**Tests:**
- Author has capability at fire time → fires normally
- Author role downgraded → capability check fails; `outcome: 'forbidden'`; `metadata.currentRole` recorded
- Author identity gone → `principalRehydrationFailed: true`; same outcome
- Auth provider unreachable → retry per standard policy; max-retries → failed

**Risk:** medium. Auth integration is well-defined but boundary errors (expired JWT, network blips) need careful handling.

### Cut 6: Lazy visibility evaluation in renderer

**Files added:**
- `packages/gazetta/src/scheduling/visibility.ts`:
  - `isVisibleNow(schedule: ScheduleField | undefined, now = Date.now()): boolean` — pure predicate

**Files modified:**
- `packages/gazetta/src/renderer.ts` — page render path: when `isVisibleNow(page.schedule)` is false, return 404 response (or 410 if future "expired" semantic configured)
- `packages/gazetta/src/runtime/static-target.ts` — worker-side capability check: if target supports lazy evaluation, check predicate; otherwise serve whatever HTML exists (capability gap warning)

**Tests:**
- `isVisibleNow` matrix: no schedule → true; activeFrom future → false; activeUntil past → false; within window → true; window inverted → undefined behavior (V4 validator catches)
- Renderer test: archived-by-window page returns 404 when out of window
- Sitemap test: items outside visibility window excluded from sitemap

**Risk:** medium. Predicate is simple; integration with the sitemap + worker route table is the careful part.

**Capability-gap UX (Cut 9 wires the surfaces; Cut 6 just provides the predicate primitive):** worker-aware targets evaluate per-request; plain-static targets serve whatever static HTML exists (visibility filter doesn't fire).

### Cut 7: Validators

**Files added:**
- `packages/gazetta/src/validation/validators/schedule-conflict.ts` (V1)
- `packages/gazetta/src/validation/validators/schedule-action-not-supported-on-target.ts` (V2)
- `packages/gazetta/src/validation/validators/schedule-past-execute-time.ts` (V3)
- `packages/gazetta/src/validation/validators/schedule-window-inverted.ts` (V4)
- `packages/gazetta/src/validation/validators/schedule-author-lacks-capability.ts` (V5)
- `packages/gazetta/src/validation/validators/schedule-on-archived-item-non-unarchive.ts` (V6)

**Files modified:**
- `packages/gazetta/src/validation/registry.ts` — register the 6 new validators

**Tests:**
- Unit per validator: matrix of (input shape × scheduling state) → expected severity + message
- Integration: save-delta with schedule conflict → save 409 with validator issue (V4-V6 errors block; V1-V3 warns)
- Integration: background scanner with synthetic site → finds expected issue counts

**Risk:** low. Standard validator pattern.

### Cut 8: Admin-API routes

**Files added:**
- `packages/gazetta/src/admin-api/routes/scheduling.ts`:
  - `GET /api/scheduler/pending` — list pending schedules across the site
  - `GET /api/scheduler/recent` — recently-fired schedules
  - `GET /api/scheduler/failed` — failed schedules awaiting operator action
  - `GET /api/scheduler/stuck` — stuck-lock schedules (rare)
  - `POST /api/scheduler/:scheduleId/fire-now` — manually fire a pending schedule (operator override)
  - `POST /api/scheduler/:scheduleId/cancel` — cancel pending schedule
  - `POST /api/scheduler/:scheduleId/re-attribute` — re-attribute failed schedule to a different author
  - `POST /api/scheduler/clear-stuck` — bulk-revert stuck locks (admin only)

**Files modified:**
- Audit: each handler emits the corresponding action with metadata per design Q7
- Cache: invalidate `pages:` / `fragments:` per design Q11
- Capability gates: `read:scheduler` for read endpoints; `schedule:cancel` for cancel; admin-only for `clear-stuck`

**Tests:**
- Each route round-trip
- Capability gates (403 without `read:scheduler` etc.)
- Pagination at envelope (100+ pending schedules)
- Audit: each operation records correct action + metadata

**Risk:** medium. Wiring is mechanical; correctness comes from underlying Cut 4 + Cut 5.

### UX research pass (between Cut 8 and Cut 9)

**Not a cut.** ~5-7 hours of focused UX research before detailed UI work begins.

**Files added:**
- `.claude/rules/design-scheduling-ux.md` — detailed UX design with verified competitor research

**Activities:**
- Inspect 5 CMSes' actual scheduling UX (WordPress, Sanity, Contentful, Storyblok, Payload) — screenshots + walkthrough; fact-check claims
- Sketch 2-3 alternative UX shapes for each major flow (publish-with-schedule, archive-with-schedule, visibility window, schedule chip, operator dashboard)
- Walk through ~10 task scenarios per shape ("schedule a publish next Friday," "find what's scheduled this month," "fix a failed schedule," "cancel an archive that's pending," etc.)
- Identify failure modes per shape
- Pick one shape per surface based on shape-vs-failure tradeoff with explicit reasoning

**Output:**
- Locked UX details: icon choices, modal copy, exact layout per surface, edge-case interaction flows
- Updates to `design-scheduling.md` Q6 lock to reference the UX doc
- Sets the spec for Cut 9-10 implementation

### Cut 9: Admin UI surfaces

**Files added:**
- `apps/admin/src/client/components/ScheduleChip.vue` — per-page schedule indicator in editor toolbar
- `apps/admin/src/client/components/ScheduleModal.vue` — modal for editing existing schedules (composable; not stand-alone)
- `apps/admin/src/client/components/VisibilityWindowEditor.vue` — inline metadata section for time-windowed visibility

**Files modified:**
- `apps/admin/src/client/components/PublishPanel.vue` — add "Schedule for..." option alongside "Publish now"
- `apps/admin/src/client/components/ArchiveModal.vue` — add "Schedule archive" option (composes with `design-soft-delete.md`'s ArchiveModal)
- `apps/admin/src/client/components/PageMetadataEditor.vue` — add Visibility section (collapsed by default; absence-as-state)
- `apps/admin/src/client/components/FragmentMetadataEditor.vue` — same
- `apps/admin/src/client/components/EditorPanel.vue` — show ScheduleChip in toolbar when schedule exists
- `apps/admin/src/client/components/SiteTree.vue` — clock icon next to scheduled items; red icon on failed schedules
- `apps/admin/src/client/stores/scheduling.ts` — Pinia store for active item's schedules

**Tests:**
- Vue Test Utils: schedule modals render correctly; capability-gap warnings shown
- E2E: schedule a publish in admin → see chip → see clock in tree → fire → see fired status
- E2E: schedule a visibility window → see metadata section → preview iframe shows 404 outside window

**Risk:** high. Visible UX; misalignment with Cut 8 + UX research breaks user trust. Heavy on E2E.

### Cut 10: Dedicated `/admin/scheduler` panel

**Files added:**
- `apps/admin/src/client/views/SchedulerView.vue` — operator dashboard route
- `apps/admin/src/client/components/SchedulerPanel.vue` — Pending / Recent / Failed / Stuck tabs
- `apps/admin/src/client/components/ScheduleRow.vue` — per-row data + actions

**Files modified:**
- `apps/admin/src/client/router/index.ts` — register `/admin/scheduler` route gated by `read:scheduler`

**Tests:**
- Vue Test Utils: each tab renders correctly with mock data
- E2E: operator with `read:scheduler` accesses panel; viewer doesn't (403)
- E2E: bulk-cancel from panel → multiple schedules cancelled with proper audit

**Risk:** medium. Standard list-view UX; pagination per `design-scale.md` patterns.

### Cut 11: CLI

**Files added:**
- `packages/gazetta/src/cli/schedule.ts`:
  - `gazetta schedule list [--filter] [--since] [--status]`
  - `gazetta schedule fire-now <scheduleId>`
  - `gazetta schedule cancel <scheduleId>`
  - `gazetta schedule clear-stuck` (admin)
  - `gazetta schedule reindex` — rebuild sidecars from manifests (recovery from external manifest edits)

**Files modified:**
- `packages/gazetta/src/cli/index.ts` — register `schedule` subcommand

**Tests:**
- CLI smoke per command
- `--filter` parsing
- `reindex` correctness: synthetic site with stale sidecars + fresh manifests → after reindex, sidecars match manifests

**Risk:** low. CLI composes existing primitives.

### Cut 12: E2E + docs

**Files added:**
- `tests/e2e/scenarios/scheduling.spec.ts` — full schedule + fire + cancel + visibility-window journey
- `tests/e2e/features/schedule-failure.spec.ts` — capability-lost + retry-exhausted
- `tests/e2e/matrix/scheduling-runtime-capabilities.spec.ts` — visibility-window on plain-static target shows capability-gap warning
- `docs/scheduling.md` — operator + author guide

**Files modified:**
- `CLAUDE.md` — link `docs/scheduling.md`; add scheduling design docs to auto-load list
- `ROADMAP.md` — mark scheduling shipped

**Risk:** low. Stable code; docs and tests reflect reality.

## Validation gate (definition of done)

- [ ] All 12 cuts merged
- [ ] UX research pass complete; `design-scheduling-ux.md` lands before Cut 9
- [ ] Manual test: schedule a publish for tomorrow → admin restart → tomorrow at scheduled time, publish fires
- [ ] Manual test: schedule a publish; downgrade author's role; at fire time, audit shows `outcome: 'forbidden'`
- [ ] Manual test: time-windowed visibility on production-static target shows capability-gap warning at all four points
- [ ] Manual test: two admin instances racing; only one fires the action; lock recovery works on crash
- [ ] CLI commands smoke-tested

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Recurring schedules (cron-style) | Concrete demand; different consumer profile |
| Per-locale schedules | Concrete demand from multi-locale operators |
| `comment` field on schedules + collaboration integration | Collaboration v1 ships first |
| Per-action operator-config catch-up overrides | First operator request |
| Per-item author-config catch-up override | First operator request |
| Schedule chains | Concrete demand |
| Approval flows on schedule creation | Already handled at fire time via review-workflow |
| Scheduled webhook firing | Future `WebhookProvider` extension surface |
| Long-running scheduled jobs | Out of scope; actions are short |
| Distributed scheduling (load-based assignment) | Out of scope; lock-based coordination works at envelope |
| External cron integration | Out of scope; Gazetta's scheduler IS the source of truth |
| `retry-exhausted` schedule cleanup CLI | Reserved-config retention; manual cleanup via `gazetta schedule cancel` for v1 |

## Open implementation questions

1. **Lock TTL per-action defaults locked at Cut 4 implementation time.** Publish=5min; archive/unarchive/redirect-activate/redirect-expire/expire-approval=30s. Refine if real measurement shows long-tail.
2. **Sidecar `readDir` performance at scale.** At envelope (~50 schedules) is fine; at hard limit (~1000 schedules) verify. If slow, add an in-memory cache scoped per scheduler tick.
3. **`If-None-Match: *` cloud provider semantics.** Verify behavior under retries (idempotent? what if first attempt succeeded but client didn't get response?). Per `design-cache.md`'s storage abstraction: providers should be idempotent.
4. **Auth provider unreachable on rehydration**: how long to retry? 3 attempts × 30s backoff = up to 90s before marking failed. Aligns with Q3 retry policy.
5. **Schedule sidecar accumulation**: failed schedules accumulate as `.failed-{ts}` files. v1 ships 30-day retention via background cleanup tick (every 24h). Configurable per `admin.scheduling.failedRetention.maxAgeDays`.
6. **Operator dashboard pagination cursor format.** Per `design-scale.md` pattern; opaque base64 of `{lastTimestamp, lastName}`.
7. **Multi-tab admin race**: same author has two browser tabs open; both see "schedule pending"; both attempt cancel. Cancel handler is idempotent (last-write-wins on schedule sidecar removal); audit emits two events; second is a no-op.

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Manifest fields) | 0.5 day |
| 2 (Atomic conditional-create) | 1 day |
| 3 (Schedule sidecars) | 1.5 days |
| 4 (Scheduler tick loop) | 3 days |
| 5 (Capability check at fire) | 1 day |
| 6 (Lazy visibility) | 1 day |
| 7 (Validators) | 1.5 days |
| 8 (Admin-API routes) | 2 days |
| **UX research pass** | **1 day (5-7 hours)** |
| 9 (Admin UI) | 4 days |
| 10 (Operator dashboard) | 2 days |
| 11 (CLI) | 1 day |
| 12 (E2E + docs) | 1.5 days |

**Total: ~22 days** (including 1 day UX research). Budget ~4-5 weeks with iteration on cuts 4 (engine) and 9 (UX).

## SOLID checks per cut

- **Cut 1:** SRP — manifest fields, schemas, etag in their respective modules.
- **Cut 2:** DIP — `StorageProvider.writeFile` interface gains optional `ifNoneMatch`; consumers depend on the interface, providers implement.
- **Cut 3:** SRP — `sidecars.ts` owns schedule-sidecar I/O; routes call it; no logic in routes.
- **Cut 4:** SRP — scheduler is its own module; lock semantics + tick loop separate from action execution. DIP — scheduler dispatches to action handlers via narrow interface.
- **Cut 5:** SRP — capability check is its own function; doesn't reach into auth internals. ISP — `rehydratePrincipal` returns `Principal | null`; consumers branch on null.
- **Cut 6:** SRP — `isVisibleNow` is a pure predicate; renderer + worker consume it; no logic duplicated.
- **Cut 7:** ISP — each validator owns one rule; OCP via registry composition.
- **Cut 8:** SRP per route handler.
- **Cut 9:** SRP per component; composition over inheritance (ScheduleChip composed by EditorPanel, not extended).
- **Cut 10:** SRP — SchedulerPanel renders; SchedulerView routes; SchedulingStore manages state.
- **Cut 11:** SRP — CLI composes existing primitives.
- **Cut 12:** Test discipline; no code SOLID concerns.
