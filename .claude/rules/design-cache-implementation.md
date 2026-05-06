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
| 1 | `cache/` infrastructure: types, errors, key conventions | ✓ | Low | Type-only foundation (shipped pre-Path-X-Phase-3) |
| 2 | `AdminCache` interface + `MemoryCache` provider with bounded LRU eviction | ✓ | Medium | The seam + v1 default (shipped pre-Path-X-Phase-3) |
| 3 | Key conventions: colon-separated, automatic Gazetta-major-version prefix, 255-char overflow-hash | ✓ | Low | Key-handling utility |
| 4 | SSE invalidation broadcast + `subscribe()` method | ☐ | Medium | Cross-instance coordination primitive |
| 5 | First real consumer (/api/pages summary) + paired save invalidation | ✓ | Medium | The contract works on real consumers; folds in the original Cut 6 (split shipped a regression). See "Per-cut scope" Cut 5 below for the audit findings on memos that don't migrate. |
| 6 | _(folded into Cut 5 — see Per-cut scope)_ | ✓ | — | Save handler invalidation paired with read-side caching to avoid shipping a stale-cache regression. |
| 7 | Stats: hit / miss / size / errors counters + structured log every 5 min + `GET /api/system/cache/stats` | ✓ | Low | Observability |
| 8 | `CacheError` taxonomy: `CacheConfigurationError`, `CacheSchemaError` | ✓ | Low | Error contracts (shipped pre-Path-X-Phase-3) |
| 9 | Per-site cache instance + per-site key auto-prefix | ✓ | Medium | Multi-site isolation |
| 10 | `adminCacheContractTests` test helper exported from `gazetta/testing` | ✓ | Low | Plugin author validation surface |
| 11 | Docs + operator config examples | ✓ | Low | User-facing |

## Per-cut scope

### Cut 1: Infrastructure

**Files added:**
- `packages/gazetta/src/cache/types.ts` — `AdminCache`, `CacheStats`, `InvalidationEvent`
- `packages/gazetta/src/cache/errors.ts` — error taxonomy
- `packages/gazetta/src/cache/keys.ts` — `encodeCacheKey()`, prefix utilities

**Tests:** key encoding + special-char handling

### Cut 2: `MemoryCache` + admin typed surface

**Files added:**
- `packages/gazetta/src/cache/memory.ts` — `createMemoryCache(opts)`; default 10K entries / 50MB cap; LRU via `Map` insertion-order with delete-then-set on hit; `subscribe()` no-op (handler stored in Set, returns disposer; Cut 4 modifies this file to wire EventEmitter for cross-instance events)

**Files modified:**
- `packages/gazetta/src/types.ts` — add `AdminConfig` + `CacheSiteConfig` interfaces; add `SiteManifest.admin?: AdminConfig`. First foundation to need typed admin-runtime concerns at the runtime-manifest layer (matches `SiteConfig.admin.cache`'s loose-record schema in `config/schemas.ts`; runtime cast bridges per existing `altText` pattern).

**Tests:** get-set-invalidate round-trip + LRU eviction at cap + invalidatePrefix returns count

**Why no `cache/provider.ts`:** `AdminCache` interface lives in Cut 1's `cache/types.ts` (colocation matches `alt/adapter.ts`, `transforms/adapter.ts` newer foundation pattern; ISP-clean since `AdminCache`, `CacheStats`, `InvalidationEvent` are one cohesive contract).

**Why flat `cache/memory.ts` (not `cache/providers/memory.ts`):** matches `alt/anthropic.ts`, `transforms/sharp.ts` — implementations flat at foundation root. The package-root `packages/gazetta/src/providers/` directory is a legacy storage-provider pattern; newer foundations colocate flat.

### Cut 3: Key conventions

**Files modified:**
- `packages/gazetta/src/cache/keys.ts` — automatic Gazetta-major-version prefix; 255-char cap with sha256 overflow-hash

**Tests:** version prefix preserves consumer-clean keys + overflow keys preserve prefix-invalidation

### Cut 4: SSE invalidation broadcast

**Files added:**
- `packages/gazetta/src/cache/sse.ts` — server-side broadcast on invalidate / invalidatePrefix

**Files modified:**
- `packages/gazetta/src/cache/memory.ts` — replace Cut 2's no-op `subscribe()` with Node EventEmitter wiring; SSE listener calls handler set via emit
- SSE channel location TBD when Cut 4 starts. Existing dev-server reload SSE lives at [`cli/index.ts`](../../packages/gazetta/src/cli/index.ts) (`/__reload`, line 1536); Cut 4 either extends it or adds a new admin-api SSE route alongside the existing `streamSSE` use in `admin-api/routes/publish.ts:522`. No `admin-api/middleware/sse.ts` exists today.

**Tests:** invalidation broadcasts + subscribers receive events + auto-reconnect with backoff (single-process; trivial case)

### Cut 5: First real consumer + save invalidation (paired)

**Reshaped from the original Cut 5 + Cut 6 plan.** The pre-implementation
draft listed three "sweep targets" — `cachedScan`, `fragmentDepsBackfill`,
the `registrySourceResolver` SourceContext map. Audit found none of them
fit the `AdminCache` contract:

| Candidate | Why not |
|---|---|
| `cachedScan` (template scan, `memoizeAsync` wrapper) | Singleflight semantics — concurrent misses share one in-flight Promise. `AdminCache.get/set` doesn't provide thundering-herd protection; migrating would regress 5 concurrent template scans on cold start. `memoizeAsync` is a published primitive (`concurrency.ts`), not ad-hoc. Stays. |
| `fragmentDepsBackfill: Map<string, Promise<void>>` | Same singleflight pattern; in-flight memo of a side-effecting build (`rebuildDepIndex`). No cached value to return. Stays. |
| `registrySourceResolver` Map | Caches `SourceContext` instances carrying function refs (`history.recordWrite`) and class instances. Violates the locked invariant "Cached values MUST be JSON-serializable" (`design-cache.md` offline composition). Stays. |

The codebase is genuinely not memo-heavy as the draft anticipated.
The right Cut 5 is: pick a real consumer that benefits from JSON-
serializable cached results and wire it through, paired with the save
invalidation Cut 6 originally separated. Splitting them ships a
regression (cache shows stale data until next save) — same lesson
called out in `design-config-implementation.md` Cut 5/Cut 10 reshuffle.

**What shipped (paired Cut 5 + Cut 6):**

Files modified:
- `packages/gazetta/src/admin-api/source-context.ts` — `SourceContext`
  gains a `cache: AdminCache` field. `createSourceContext` lazily
  builds a `MemoryCache` (and wraps with `forSite()`) when the caller
  doesn't supply one. The cache lives at SourceContext lifetime, so
  every `loadSiteFromSource(source)` returns a `Site` whose `cache`
  is the same instance — entries persist across requests.
- `packages/gazetta/src/site-loader.ts` — `LoadSiteOptions.cache`
  added; when supplied, used verbatim (already site-scoped).
  Fallback path (CLI, tests) builds a fresh wrapped cache per call.
- `packages/gazetta/src/admin-api/routes/pages.ts` — `GET /api/pages`
  reads `pages:summary` from `source.cache`, computes on miss, sets.
  Save handlers (`POST/PUT/DELETE`) call
  `source.cache.invalidatePrefix('pages:')` before returning.
- `packages/gazetta/src/admin-api/routes/fragments.ts` — same shape
  for `GET /api/fragments` (`fragments:summary`). Fragment writes
  also invalidate `pages:` because page summaries reflect fragment
  references resolvable through the loader.
- `packages/gazetta/src/admin-api/routes/history.ts` — undo and
  restore invalidate `pages:` + `fragments:` when the target is the
  source target (the common case; restoring on a non-source target
  doesn't affect this source's cache).

**Not invalidated (deliberately, to keep the diff small):**
- Asset writes — the cached page/fragment summary doesn't include
  asset refs (just `name/route/template/locales`); rename/replace/
  delete don't dirty the summary.
- Publish — writes to target storage, not source content; source
  cache stays valid.

**Tests:** existing `admin-api.test.ts` POST→GET round-trips already
exercise the contract end-to-end (creating a page then listing must
return the new page); they were failing under read-only Cut 5 and
now pass with the paired invalidation. No new test files needed —
the cache primitives are unit-tested in `cache-keys`/`cache-memory`/
`cache-per-site`; the integration is exercised via the admin-api
suite.

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

**Files added:**
- `packages/gazetta/src/cache/factory.ts` — `createAdminCache(site)` returns per-site instance with auto-prefix; matches existing foundation factory pattern (`alt/factory.ts`, `transforms/index.ts`'s `buildTransformAdapter`). Cuts 1-2 don't ship a factory because no consumer needs one until Cut 5 starts wiring cache callers — by which point per-site multi-tenant key prefixing is the load-bearing concern.

**Files modified:**
- Loader / site-loader integration: each site's cache initialized at site-load time

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
