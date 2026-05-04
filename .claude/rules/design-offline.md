---
paths:
  - "apps/admin/src/client/**"
  - "packages/gazetta/src/admin-api/**"
  - "**/offline*"
  - "**/service-worker*"
---

# Admin offline mode — design pass pending

Foundational dimension #10 of 10. Admin works through transient connectivity loss (server restart, Wi-Fi drop, VPN issue) and degrades gracefully. Read paths serve from a local persistent cache; write paths queue and replay on reconnect; conflict resolution preserves author intent.

**Status**: design pass pending — sequenced 10 of 10 (after `design-cache.md`; depends on cache abstraction + RBAC role-aware cache scope + render contract + real-time event-source for invalidation). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Offline check** every new feature design must answer
- [`design-cache.md`](design-cache.md) — caching layer; offline mode adds a persistent client-side cache
- [`design-rbac-audit-review.md`](design-rbac-audit-review.md) — role-aware cache scope; audit log records reconnect replay
- [`design-rendering.md`](design-rendering.md) — preview during offline degrades to last-cached render

## Why this is foundational

Admin offline mode is foundational because:

1. **Every UI surface respects offline state.** Banners, save buttons, picker affordances, dirty-dot semantics, validation surfaces — all need offline awareness. Adding it later means retrofitting every surface.

2. **Multi-foundational interactions.** Offline cache scope must respect role visibility (don't cache pages the user can't see). Reconnect must replay save attempts in audit-log-correct order. Real-time event source feeds offline cache invalidation. Conflict resolution interacts with the team review workflow. None of these compose right without dimension-level design.

3. **It's a quality signal at team CMS scale.** Solo authors tolerate "save failed, retry later"; team workflows hit transient connectivity issues at 100x the rate (commercial Wi-Fi, VPN reconnects, deploy windows). Graceful offline behavior differentiates "professional CMS" from "demo CMS."

4. **Save-pending model already half-supports it.** The current pending-edits model (per the bug #106 fix) keeps content + structural changes in browser memory until explicit save. Offline mode extends this naturally — pending edits become persistent across browser reload, save attempts queue, reconnect replays.

## Locked invariants

- **Pending edits persist across browser reload.** The existing pending-edits Pinia stores (`editorContent`, `editorStash`, `editorStructural`) hydrate from IndexedDB or localStorage on admin boot.
- **Read paths degrade to last-cached.** When the server is unreachable, `/api/pages`, `/api/fragments`, `/api/assets` etc. return cached results with a staleness indicator. Cache backed by `AdminCache` with a persistent provider (`IndexedDBCache` or `LocalStorageCache`) — extends the cache provider taxonomy.
- **Write paths queue.** Save / publish attempts during offline are queued in browser storage; replayed on reconnect in submission order. Conflict on replay surfaces the standard validation banner.
- **Cache scope respects RBAC.** Cached entries are scoped to the role principal at cache time; switching role / re-auth invalidates the cache. Don't leak data across role switches.
- **Audit log on reconnect.** Replay events go to audit log with `replayed: true` + original-attempt timestamp. Operators see the offline activity later.

## Cache shape (browser-side persistent cache)

The cache provider taxonomy from `design-cache.md` extends with a browser-side persistent layer:

```ts
// In addition to the server-side AdminCache providers (Memory, Redis, Azure...)
// the admin client gets persistent client-side cache providers:

// Browser IndexedDB — large quotas (~50MB+), structured queries
class IndexedDBCache implements AdminCache { ... }

// Browser localStorage — small quotas (~5MB), simple key-value
// Useful as fallback for older browsers
class LocalStorageCache implements AdminCache { ... }
```

**Server-side AdminCache and client-side AdminCache share the interface but operate independently.** The server caches for hot-path reads; the client caches for offline tolerance. They're coordinated via SSE invalidation events — when the server invalidates `pages:`, it broadcasts to connected clients to invalidate their browser caches.

## Open questions for the design pass

### Multi-instance check
- Browser-side cache is per-browser-tab (IndexedDB/localStorage scoped to origin + browser session). Two tabs on the same browser share IndexedDB; two browsers don't. No cross-instance coordination needed at the browser layer.
- Reconnect-replay queue is per-browser. Two browsers each replay their own queue independently — last-write-wins on the server (existing semantics).
- Server-side: offline-mode features don't require server changes; the SSE infrastructure (already per-instance) broadcasts cache invalidations to connected clients of that instance. Cross-instance coordination uses audit log per the real-time event-source discipline.

### Persistence layer choice
- IndexedDB: ~50MB+ quota, structured queries, async API. Modern browsers, good DX. Default.
- localStorage: ~5MB, sync API, simpler. Fallback for low-end / older environments.
- File System Access API: 2026-era; could enable larger persistent caches but compatibility is still uneven.
- OPFS (Origin Private File System): browser-tab-private fs sandbox; relevant when caches grow past IndexedDB quota.
- Decision: ship IndexedDB primary + localStorage fallback. Operator-configurable via `site.yaml admin.offline`.

### Reconnect detection
- `navigator.onLine` is unreliable (browsers sometimes report online when network is broken).
- Heartbeat ping to server (every N seconds) more accurate; costs requests when not needed.
- Decision: hybrid — `navigator.onLine` triggers offline UI immediately; heartbeat confirms / corrects.

### Conflict resolution on reconnect
- Server returns 409 VALIDATION_FAILED for content-validation conflicts (already handled by Cut 1 banner).
- New: 409 STALE for "another author saved this manifest while you were offline; your save would overwrite."
- Two strategies:
  - **Force-save with banner** — author chose to come back online; show what changed; operator confirms overwrite or discards local
  - **Three-way merge** — automatic for non-conflicting fields; manual for collisions
- Decision deferred to design pass; v1 likely starts with force-save banner, three-way merge in v2 if demand surfaces.

### Cache freshness UI
- Staleness indicator format: "synced X minutes ago" vs. "offline since X" vs. silent
- Different signals for cached read (mostly-fresh) vs. queued write (definitely-pending)
- Per-page staleness vs. global "offline mode" indicator

### Audit log shape for offline replays
- Single revision per replayed save? Or batch of replays as one revision? Batch is more efficient but loses ordering.
- Original-attempt timestamp recorded as field on revision; replayed-at timestamp as separate field.
- Per `design-rbac-audit-review.md`'s audit log shape — refined when that design pass formalizes.

### Composition with each foundational dimension
- **Scale**: cache size budget at 5000 pages. IndexedDB quota at 50MB / page summary 150 bytes = 333K cacheable summaries — generous headroom.
- **Themes**: cache key includes active theme; theme switch invalidates per-theme entries.
- **Locale**: cache key includes active locale; same pattern.
- **RBAC**: cache scoped to role principal; role change invalidates.
- **Hooks**: hook firings during offline queue with the save; replayed on reconnect.
- **Render**: preview during offline serves last-cached HTML; iframe shows staleness banner.
- **Validation**: save-delta validation runs locally during offline (validators are pure functions); errors surface in banner. Background scanner pauses; reconnect resumes.
- **Plugin**: plugins inherit offline behavior of their host surface; plugin-supplied storage providers must be offline-aware OR documented as online-only.
- **Cache**: extends taxonomy with `IndexedDBCache` + `LocalStorageCache` browser-side providers.

## Migration

Sites without offline mode configured continue to work — pending edits stay in-memory only (current behavior); save fails surface as toast. Operators opt in via `site.yaml admin.offline.enabled: true`.

Existing pending-edits state in Pinia stores migrates to persistent storage when offline mode is enabled — first save queue / cache write triggers IndexedDB initialization; subsequent reads/writes go through persistent layer.

## Future directions

**Multi-author offline collaboration.** Two authors offline on the same content; reconnect produces conflict that's not just save-vs-save but author-vs-author. Composes with concurrent editing (Tier 3 OT/CRDT bet) — out of v1.

**Offline-first PWA installation.** Admin SPA as installable PWA (`manifest.json` + service worker). Standalone window, app-shell pattern. Out of v1; opt-in feature for operators.

**Selective offline cache (per-section).** Operators choose which content to keep offline (e.g., "all blog pages" but not "all marketing assets"). Storage budget management. Out of v1.

**Background sync with deferred replay.** Service Worker `background-sync` API replays the queue even after the tab closes. Browser-dependent; v2 enhancement when modern browsers fully support it.
