---
paths:
  - "packages/gazetta/src/cache/**"
  - "packages/gazetta/src/admin-api/**"
---

# Cache — Implementation

Companion to [design-cache.md](design-cache.md). Cut sequence with risk ordering.

See [design-cache.md](design-cache.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `cache-v1` off `main`. **No backwards compatibility** — replaces existing memos in-place.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `cache/` infrastructure: types, errors, key conventions | ☐ | Low | Type-only foundation |
| 2 | `AdminCache` interface + `MemoryCache` provider with bounded LRU eviction | ☐ | Medium | The seam + v1 default |
| 3 | Key conventions: colon-separated, automatic Gazetta-major-version prefix, 255-char overflow-hash | ☐ | Low | Key-handling utility |
| 4 | SSE invalidation broadcast + `subscribe()` method | ☐ | Medium | Cross-instance coordination primitive |
| 5 | Sweep existing memos: `findDependentsFromSidecars`, template-scan cache, locale-cache → migrate to `AdminCache.MemoryCache` | ☐ | Medium | Real consumers; replaces ad-hoc memos |
| 6 | Save handler invalidation: `cache.invalidatePrefix('pages:')` etc. on save / publish | ☐ | Low-medium | Explicit per-feature invalidation |
| 7 | Stats: hit / miss / size / errors counters + structured log every 5 min + `GET /api/system/cache/stats` | ☐ | Low | Observability |
| 8 | `CacheError` taxonomy: `CacheConfigurationError`, `CacheSchemaError` | ☐ | Low | Error contracts |
| 9 | Per-site cache instance + per-site key auto-prefix | ☐ | Medium | Multi-site isolation |
| 10 | `adminCacheContractTests` test helper exported from `gazetta/testing` | ☐ | Low | Plugin author validation surface |
| 11 | Docs + operator config examples | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Infrastructure

**Files added:**
- `packages/gazetta/src/cache/types.ts` — `AdminCache`, `CacheStats`, `InvalidationEvent`
- `packages/gazetta/src/cache/errors.ts` — error taxonomy
- `packages/gazetta/src/cache/keys.ts` — `encodeCacheKey()`, prefix utilities

**Tests:** key encoding + special-char handling

### Cut 2: `AdminCache` + `MemoryCache`

**Files added:**
- `packages/gazetta/src/cache/provider.ts` — `AdminCache` interface
- `packages/gazetta/src/cache/providers/memory.ts` — `MemoryCache` with default 10K entries / 50MB cap; LRU eviction

**Tests:** get-set-invalidate round-trip + LRU eviction at cap + invalidatePrefix returns count

### Cut 3: Key conventions

**Files modified:**
- `packages/gazetta/src/cache/keys.ts` — automatic Gazetta-major-version prefix; 255-char cap with sha256 overflow-hash

**Tests:** version prefix preserves consumer-clean keys + overflow keys preserve prefix-invalidation

### Cut 4: SSE invalidation broadcast

**Files added:**
- `packages/gazetta/src/cache/sse.ts` — server-side broadcast on invalidate / invalidatePrefix
- `packages/gazetta/src/cache/providers/memory.ts` — `subscribe()` via Node EventEmitter

**Files modified:**
- `packages/gazetta/src/admin-api/middleware/sse.ts` (extends existing dev-server reload SSE) — adds invalidation channel

**Tests:** invalidation broadcasts + subscribers receive events + auto-reconnect with backoff (single-process; trivial case)

### Cut 5: Sweep existing memos

**Files modified:**
- `packages/gazetta/src/source-sidecars.ts` (memoization) — migrate to `AdminCache`
- `packages/gazetta/src/locale.ts` (locale cache) — migrate
- `packages/gazetta/src/manifest.ts` (template-scan cache) — migrate
- Other ad-hoc memos identified during cut

**Tests:** equivalence tests confirm cache hits return same shapes as pre-migration

### Cut 6: Save handler invalidation

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — explicit `cache.invalidatePrefix('pages:')` on save; sidecar-driven cascade invalidates dependent pages
- Similar in `fragments.ts`, `assets.ts`, `publish.ts`

**Tests:** save invalidates correct prefix; sidecar cascade invalidates dependents

### Cut 7: Stats

**Files added:**
- `packages/gazetta/src/cache/stats.ts` — counter increment on every operation
- `packages/gazetta/src/admin-api/routes/system.ts` (NEW) — `GET /api/system/cache/stats`
- Periodic 5-minute structured log via `setInterval` in cache provider

**Tests:** stats accuracy + logging cadence (mocked timer)

### Cut 8: `CacheError` taxonomy

**Files modified:**
- `packages/gazetta/src/cache/errors.ts` — flesh out subclasses
- `packages/gazetta/src/cache/providers/memory.ts` — throw `CacheConfigurationError` on bad config

**Tests:** error classes have correct names + stack preservation

### Cut 9: Per-site cache instance + key prefix

**Files modified:**
- `packages/gazetta/src/cache/factory.ts` — `createAdminCache(site)` returns per-site instance with auto-prefix
- Loader: each site's cache initialized at site-load time

**Tests:** two sites in same project don't collide on cache keys

### Cut 10: Contract test helper

**Files added:**
- `packages/gazetta/testing/admin-cache-contract.ts` — `adminCacheContractTests(factory, name)` test suite for plugin authors

**Tests:** the helper itself runs against `MemoryCache` (proves it's correct); plugin authors run it against their providers

### Cut 11: Docs

**Files added/modified:**
- `docs/cache.md` (NEW) — operator guide
- `examples/starter/site.config.ts` — example `admin.cache` block

## Validation gate (definition of done)

- [ ] All 11 cuts merged
- [ ] Existing memos all migrated to `AdminCache`
- [ ] Stats endpoint returns expected counters
- [ ] Plugin authors can run `adminCacheContractTests` against their provider

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `RedisCache` provider | Multi-instance deployment with concrete cache-hit-rate concern |
| `AzureCache` provider | Azure-deployment operator demand |
| `FileCache` provider | Single-server operator demand for restart-survival |
| `EtagCapableCache extends AdminCache` (RMW interface) | First read-modify-write consumer (warming hooks future) |
| Cache warming hooks | After Hooks foundation lands; concrete demand for boot-time cache pre-population |
| Stats `bytesApproximate` field | Operator demand for byte-level monitoring |
| Per-validator severity override at publish gate | Per-validator config; deferred from validation Cut 4 |

## Estimates

| Cut | Estimate |
|---|---|
| 1-2 | 1 day |
| 3-4 | 1 day |
| 5 | 1.5 days |
| 6 | 0.5 day |
| 7 | 0.5 day |
| 8 | 0.5 day |
| 9 | 0.5 day |
| 10 | 0.5 day |
| 11 | 0.5 day |

**Total: ~6-7 days.**

## SOLID checks per cut

- **Cut 1-2**: SRP per file. DIP — consumers depend on `AdminCache` interface.
- **Cut 5**: each migration replaces ad-hoc memo with `AdminCache` consumption; consumer site doesn't grow more responsibility.
- **Cut 9**: per-site factory keeps multi-site concerns out of provider implementations.
- **Cut 10**: contract test helper enforces LSP across providers.
