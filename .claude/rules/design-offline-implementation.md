---
paths:
  - "apps/admin/src/client/**"
  - "packages/gazetta/src/admin-api/**"
  - "**/offline*"
  - "**/service-worker*"
---

# Admin offline mode — Implementation

Companion to [design-offline.md](design-offline.md). Cut sequence with risk ordering.

See [design-offline.md](design-offline.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `offline-v1` off `main`. Sequenced after AdminCache (depends on `AdminCache` interface for L6 provider). **No backwards compatibility**; existing pending-edits stores migrate to IndexedDB-backed persistence.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | npm dependencies + setup: `idb`, `@tanstack/vue-query`, `@tanstack/query-async-storage-persister`, `vite-plugin-pwa` | ☐ | Low | Tooling foundation |
| 2 | `IndexedDBCache` provider (browser-side `AdminCache`) using `idb` | ☐ | Medium | The L6 cache primitive |
| 3 | Provider selection: `IndexedDBCache` primary; `MemoryCache` fallback when IndexedDB unavailable | ☐ | Low | Graceful degradation |
| 4 | BroadcastChannel cross-tab invalidation | ☐ | Low | Multi-tab coordination |
| 5 | Vue Query setup + `IndexedDBPersister` bridge to L6 | ☐ | Medium | Query/mutation cache + offline queue |
| 6 | Connection state Pinia store: hybrid `navigator.onLine` + heartbeat to `/api/health` | ☐ | Medium | 5-state model |
| 7 | Health endpoint `GET /api/health` | ☐ | Low | Server-side support |
| 8 | Pending-edits store migration: persist to IndexedDB; survive reload | ☐ | Medium | Editor state persistence |
| 9 | Save queue: client-generated thread IDs + chained If-Match etag projections | ☐ | High | Conflict-on-replay machinery |
| 10 | Conflict UX: 409 STALE handling; field-by-field semantic diff banner; Show / Discard actions | ☐ | High | Conflict resolution UX |
| 11 | Service worker via vite-plugin-pwa: app-shell precache | ☐ | Medium | Cold-load offline reliability |
| 12 | UX indicators: cloud-with-slash icon + offline banner + "Send now" affordance + sync-state metadata | ☐ | Medium | Krug-aligned visibility |
| 13 | Mid-save connection-loss handling: retry-with-If-Match; idempotency | ☐ | Medium | Edge case correctness |
| 14 | Storage quota warning at 80% | ☐ | Low | Operator UX |
| 15 | Audit integration: `metadata.replayed: true` + `queuedAt` + `replayedAt` | ☐ | Low | Composes with audit foundation |
| 16 | Docs + first-run author guide | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Dependencies

**Files modified:**
- `apps/admin/package.json` — add `idb`, `@tanstack/vue-query`, `@tanstack/query-async-storage-persister`, `vite-plugin-pwa`

**Tests:** install + build

### Cut 2: `IndexedDBCache`

**Files added:**
- `apps/admin/src/client/cache/indexeddb-cache.ts` — implements `AdminCache` from `gazetta` package

**Tests:** `adminCacheContractTests` from `gazetta/testing` runs against this provider

### Cut 3: Provider selection

**Files added:**
- `apps/admin/src/client/cache/provider-selector.ts` — boot-time probe; falls back to MemoryCache + warning banner

**Tests:** IndexedDB unavailable → MemoryCache returned + banner emitted

### Cut 4: BroadcastChannel

**Files modified:**
- `apps/admin/src/client/cache/indexeddb-cache.ts` — broadcast on invalidate; subscribe handler invalidates local in-memory mirror

**Tests:** two tabs simulated; invalidation propagates

### Cut 5: Vue Query setup + persister bridge

**Files added:**
- `apps/admin/src/client/queries/client.ts` — `QueryClient` with `IndexedDBPersister` adapter
- `apps/admin/src/client/queries/persister.ts` — bridges Vue Query to `IndexedDBCache`

**Tests:** Vue Query state rehydrates from IndexedDB at boot

### Cut 6: Connection state store

**Files added:**
- `apps/admin/src/client/stores/connectionState.ts` — Pinia store; 5 states; navigator.onLine + heartbeat hybrid; subscribes Vue Query's onlineManager

**Tests:** state transitions on simulated connection events

### Cut 7: Health endpoint

**Files added:**
- `packages/gazetta/src/admin-api/routes/system.ts` — `GET /api/health` (extends from cache stats route)

**Tests:** returns `{ ok: true, timestamp }`

### Cut 8: Pending-edits store migration

**Files modified:**
- `apps/admin/src/client/stores/editing.ts` — persist `editorContent`, `editorStash`, `editorStructural` to IndexedDB; hydrate on boot

**Tests:** browser reload preserves pending edits across navigation

### Cut 9: Save queue (highest risk cut)

**Files added:**
- `apps/admin/src/client/queries/save-queue.ts` — client-generated UUIDs; chained If-Match projections; sequential replay on reconnect

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — return `etag: <content-hash>` on read; honor `If-Match` on write; return `409 STALE` with current version metadata on mismatch

**Tests:** offline saves chain correctly; replay produces sequential success; conflict on first save pauses subsequent

### Cut 10: Conflict UX

**Files added:**
- `apps/admin/src/client/components/ConflictBanner.vue` — Show diff / Discard actions
- `apps/admin/src/client/components/DiffView.vue` — field-by-field semantic diff

**Tests:** 409 STALE response triggers banner; "Discard" reverts pending edits; "Show diff" navigates to diff view

### Cut 11: Service worker

**Files modified:**
- `apps/admin/vite.config.ts` — add `vite-plugin-pwa` with `injectManifest` strategy
- `apps/admin/src/client/sw.ts` (NEW) — service worker source; precache app shell

**Tests:** SW registers in production build; cold-load offline serves from cache

### Cut 12: UX indicators

**Files added/modified:**
- `apps/admin/src/client/components/SyncStatusIndicator.vue` — cloud-with-slash icon component
- `apps/admin/src/client/components/OfflineBanner.vue` — global banner per connection state

**Tests:** indicator only shows when relevant (Krug "absence is a state")

### Cut 13: Mid-save connection-loss

**Files modified:**
- `apps/admin/src/client/queries/save-queue.ts` — handle in-flight save when connection drops; retry with same If-Match for idempotency

**Tests:** simulated mid-save drop → retry succeeds with idempotent server response

### Cut 14: Storage quota warning

**Files added:**
- `apps/admin/src/client/composables/useStorageQuota.ts` — `navigator.storage.estimate()` polling; warning at 80%

**Tests:** simulated 80% quota → banner visible

### Cut 15: Audit integration

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — `metadata.replayed: true`, `metadata.queuedAt`, `metadata.replayedAt` field schemas
- Save handlers — record audit events with replay metadata when If-Match indicates replay

**Tests:** replay events audit with full metadata

### Cut 16: Docs

**Files added/modified:**
- `docs/offline.md` (NEW) — operator + author guide

## Validation gate (definition of done)

- [ ] All 16 cuts merged
- [ ] Manual test: edit page offline → close laptop → reopen → edits persist → reconnect → sync invisibly
- [ ] Conflict scenario test: edit offline + concurrent online edit → reconnect → conflict banner surfaces
- [ ] Service worker test: cold-load admin offline → SPA loads from cache

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Background Sync API (replay with tab closed) | v2 ergonomic improvement |
| PWA install prompt (`manifest.json`) | Operator opt-in feature |
| Push notifications | When Notification Provider extension surface ships email/Slack |
| Three-way merge conflict resolution | Concurrent editing Tier 3 strategic bet |
| Per-locale comments / per-locale conflict | Concrete demand |
| OPFS as L6 provider | Site exceeds IndexedDB quota OR worker-thread sync writes needed |
| `last-cached` failure mode | Concrete demand |
| Activity feed | Composes from audit log when feed surface exists |

## Open implementation questions

1. **`IndexedDBPersister` debounce**: how often to write Vue Query cache to IndexedDB? Recommend 500ms debounce on changes; trade-off between write frequency and data-loss-on-crash window.
2. **Service worker update flow**: vite-plugin-pwa supports `skipWaiting` + `clientsClaim`; recommend with toast notification "New version available — refresh." Author dismisses or refreshes; auto-activates on next navigation.
3. **`If-Match` etag granularity**: per-page-manifest (current sidecar `.{8hex}.hash`) is fine. For inline-component-level conflict detection (future), would need per-component etags; deferred.

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Deps) | 0.5 day |
| 2-4 (IDB cache + selection + BroadcastChannel) | 2 days |
| 5 (Vue Query) | 1.5 days |
| 6-7 (Connection + health) | 1 day |
| 8 (Pending-edits) | 1 day |
| 9 (Save queue) | 2.5 days |
| 10 (Conflict UX) | 2 days |
| 11 (Service worker) | 1.5 days |
| 12 (UX indicators) | 1.5 days |
| 13-14 (Mid-save + quota) | 1 day |
| 15 (Audit) | 0.5 day |
| 16 (Docs) | 1 day |

**Total: ~16-17 days.** Highest cut count + highest risk pass; budget ~3-4 weeks with iteration.

## SOLID checks per cut

- **Cut 2-4**: SRP per file (cache provider / selector / cross-tab broadcaster). DIP — admin code consumes `AdminCache`.
- **Cut 5**: Vue Query as separate layer; doesn't blend into AdminCache responsibilities.
- **Cut 9-10**: save queue + conflict UX are separate modules. Diff view is its own component.
- **Cut 11**: service worker scope is explicit (app shell only); doesn't touch query / mutation logic.
- **Cut 12**: indicators consume connection-state store; no business logic in components.
