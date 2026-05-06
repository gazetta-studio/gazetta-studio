---
paths:
  - "apps/admin/src/client/components/SiteTree.vue"
  - "apps/admin/src/client/components/ComponentTree.vue"
  - "apps/admin/src/client/components/AssetLibrary.vue"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/assets.ts"
  - "packages/gazetta/src/storage/**"
---

# Scale — Implementation

Companion to [design-scale.md](design-scale.md). Cut sequence with risk ordering.

See [design-scale.md](design-scale.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `scale-v1` off `main`. **No backwards compatibility** — replaces flat-list endpoints + tree rendering in-place.

The cuts are sequenced server-first (endpoints + cache integration) then client (tree, asset library) so the wire contract is set before the UI consumes it. Benchmark scaffolding lands first so each subsequent cut has a regression gate.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | Synthetic 5K-page fixture + benchmark suite + perf-regression CI | ☐ | Low | Measurement floor; everything below gates against this |
| 2 | `StorageProvider.recommendedConcurrency` + `mapLimit` integration | ☐ | Low | Provider-aware concurrency primitive |
| 3 | `GET /api/pages` prefix-shard contract (no params → top-level + prefix counts; `?prefix=` → page summaries) | ☐ | Medium | Wire contract for prefix-sharded reads |
| 4 | `GET /api/pages/search?q=` server-side search endpoint | ☐ | Medium | Cross-prefix lookups |
| 5 | `AdminCache` integration on `/api/pages` summary + search + paired save invalidation | ☐ | Medium | Cache contract on real consumer at scale |
| 6 | Eager warm at boot (top-level + prefix list) | ☐ | Low | First-request latency on cloud sources |
| 7 | Same prefix-shard + search + cache pattern for `/api/fragments` | ☐ | Low | Mirrors Cut 3-5 at smaller scale |
| 8 | `GET /api/assets` cursor-based pagination + filter endpoints | ☐ | Medium | Asset library wire contract |
| 9 | `SiteTree.vue` hierarchical-on-route + always-on search + `@tanstack/vue-virtual` at ~100-row threshold | ☐ | High | The visible UX |
| 10 | `ComponentTree.vue` per-build fragment-resolution cache + virtualization + depth/200-component banners | ☐ | Medium | Component tree at envelope |
| 11 | `AssetLibrary.vue` virtualized grid + lazy thumbnails + cursor pagination | ☐ | Medium | Library at 20K assets |
| 12 | Compare/Publish dialog summary view above 200-changed-items threshold | ☐ | Low | Compare/publish at fan-out scale |
| 13 | Docs (`docs/scale.md` operator + envelope reference) + ROADMAP + CLAUDE.md update | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Synthetic fixture + benchmark suite + CI gate

**Files added/modified:**
- `packages/gazetta/tests/_helpers/synthetic-site.ts` — extend existing helper to emit 5000-page realistic-shape fixture; deterministic seed
- `packages/gazetta/tests/perf-pages.bench.ts` — `/api/pages` cold/warm; `?prefix=`; `/search` (the latter two skipped until cuts 3-4 ship)
- `packages/gazetta/tests/perf-assets.bench.ts` — `/api/assets` paginated
- `packages/gazetta/tests/perf-validation.bench.ts` — save-delta validation; background scan boot
- `scripts/profile-site.sh` — manual operator profile runner
- `.github/workflows/perf.yml` — nightly perf gate; fail on >10% regression OR p99 above SLA

**Tests:** synthetic site generates deterministically (same seed → same shape); benchmark suite produces p50/p95/p99 metrics; CI workflow lint passes.

**Why first:** every subsequent cut needs a regression gate. The fixture also lets us verify the design pass's locked SLA targets (5K pages: cold ~150ms, warm ~10ms) hold today, before any of the new strategies ship.

**Risk:** low. The synthetic helper exists; this cut extends it. No production code touched.

### Cut 2: Provider-aware concurrency

**Files modified:**
- `packages/gazetta/src/types.ts` — add `StorageProvider.recommendedConcurrency: number` (numeric, not method — providers know their bound at construction)
- `packages/gazetta/src/providers/filesystem.ts` — `recommendedConcurrency: 20` (matches existing `DEFAULT_CONCURRENCY`)
- `packages/gazetta/src/providers/r2.ts` — `recommendedConcurrency: 100`
- `packages/gazetta/src/providers/s3.ts` — `recommendedConcurrency: 100`
- `packages/gazetta/src/providers/azure-blob.ts` — `recommendedConcurrency: 100`
- `packages/gazetta/src/concurrency.ts` — `mapLimit(items, fn, limit)` already exists; expose `mapLimitForProvider(items, fn, provider)` that reads `recommendedConcurrency`

**Tests:** each provider declares the expected concurrency; `mapLimitForProvider` respects it; no regression in existing concurrency-using callers.

**SOLID:** SRP — the provider knows its own bound; consumers don't hardcode per-provider numbers. ISP — `recommendedConcurrency` is a single field, not a capability interface.

**Risk:** low. The new field is additive; existing callers still use `mapLimit(items, fn, DEFAULT_CONCURRENCY)` until cut 3 migrates them.

### Cut 3: `/api/pages` prefix-shard contract

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — restructure `GET /api/pages`:
  - No params → `{ topLevel: PageSummary[], prefixes: { prefix: string, count: number }[] }`
  - `?prefix=blog/` → `{ pages: PageSummary[] }`
- `packages/gazetta/src/admin-api/schemas/pages.ts` — add `PrefixedPagesResponse`, `PrefixListItem` schemas
- `apps/admin/src/client/api/client.ts` — `getPages()` returns the new shape; add `getPagesByPrefix(prefix)`

**Tests:**
- `admin-api.test.ts` — top-level shape + prefix shape + empty-prefix edge case + non-existent prefix → 404
- Bench: `?prefix=` against 5K-page fixture stays under SLA

**Why now:** the wire contract is the load-bearing seam. Once shipped, the tree (Cut 9) and any other consumer can rely on it. Splitting tree before contract would force tree to consume the legacy flat list and then re-migrate.

**Risk:** medium. Existing callers expect the flat-list shape; this cut is the cutover. No backwards-compat means every consumer migrates in this cut.

### Cut 4: Search endpoint

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — `GET /api/pages/search?q=foo` returns flat `PageSummary[]` matching name/route/title metadata
- Schema for the response
- Client API method `searchPages(q)`

**Tests:** substring case-insensitive on each field; whitespace trimming; empty `q` → 400; bench at 5K pages stays under SLA.

**Risk:** medium. Walking 5K pages on every keystroke needs careful instrumentation (debounced client-side; provider-aware concurrency on server).

### Cut 5: `AdminCache` integration + save invalidation (paired)

**Per the lesson in `design-cache-implementation.md` Cut 5/6 reshuffle**: cache reads + save-side invalidation must ship in the same cut. Splitting them ships a stale-data regression.

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts`:
  - `GET /api/pages` (both shapes): `source.cache.get('pages:summary:...')` first; on miss, compute + set
  - Same for `/api/pages/search` results — cache key includes the query string
  - `POST/PUT/DELETE` save handlers: `source.cache.invalidatePrefix('pages:')` before returning
- Cache key conventions per `design-cache.md` Q1: `pages:top-level`, `pages:prefix:{prefix}`, `pages:search:{q}`, all under per-site auto-prefix

**Tests:**
- `admin-api.test.ts` — POST→GET round-trip serves fresh data (validates invalidation works end-to-end)
- Bench: warm read of `/api/pages` is microsecond-scale (cache hit)

**Why paired:** read-only caching without invalidation = stale list after a save. The lesson is documented; we don't repeat it.

**Risk:** medium. Wrong invalidation prefix = silent staleness for hours. The integration tests catch round-trip failures.

### Cut 6: Eager warm at boot

**Files modified:**
- `packages/gazetta/src/admin-api/index.ts` (or boot path) — after server constructs, kick off `Promise.all([getPages(), getFragments()])` to populate the cache; non-blocking (boot proceeds; warm completes async)
- Logged via `module: 'admin-api.warm'` per `design-logging.md` conventions

**Tests:** boot completes without warming first; warm completes in expected time on filesystem (verified via bench).

**Risk:** low. Failure in warm = first request takes the cold path (existing behavior). Fail-open.

### Cut 7: `/api/fragments` mirror

Same pattern as cuts 3+4+5 applied to fragments. Smaller scale (envelope: 500 fragments) but the wire contract should match for consumer predictability.

**Files modified:**
- `packages/gazetta/src/admin-api/routes/fragments.ts` — prefix-shard + search + cache integration
- Schema additions
- Client API methods

**Tests:** parity with `/api/pages` test suite.

**Risk:** low. Direct port of cuts 3-5.

### Cut 8: `/api/assets` pagination + filters

**Files modified:**
- `packages/gazetta/src/admin-api/routes/assets.ts`:
  - `GET /api/assets?cursor=&limit=` — cursor-based pagination (default 100/page)
  - `GET /api/assets/search?q=&kind=&tag=` — filter combinations
- Schema for paginated response (`{ items: AssetSummary[], nextCursor: string | null }`)
- Cache integration like cuts 5+7

**Cursor encoding:** opaque base64 of `{ lastName, sortKey }` — stable, doesn't depend on shared state. Multi-instance correct.

**Tests:**
- Pagination: walk through 20K asset fixture; `nextCursor` stable across calls
- Filter: kind=image; tag=hero; combined; empty match → empty array (not 404)
- Bench: page 1 + page 200 latencies under SLA

**Risk:** medium. Cursor encoding bugs = duplicate or missing pages on iteration. Property-based test for stability across reorderings.

### Cut 9: SiteTree.vue — hierarchy + search + virtualization

**Files modified:**
- `apps/admin/src/client/components/SiteTree.vue` — full restructure:
  - Hierarchical render driven by route paths (`/blog/*` → `blog/` synthetic group)
  - Always-on search box at the top; case-insensitive; default client-side filter
  - At >1000 pages: switch to server-side via `searchPages()` (Cut 4)
  - `@tanstack/vue-virtual` v3 for branches with >100 visible rows
  - URL hash for selection memory (existing pattern; preserve)
- `apps/admin/src/client/composables/useSiteTreeData.ts` (NEW) — encapsulates the tree-data fetching: `getPages()` for top-level + prefixes; lazy `getPagesByPrefix(prefix)` on expand

**Dynamic-route pages** (`blog/[slug]`) render as a single node with instance-count badge; expand reveals matched instances (driven by routes that match the dynamic pattern).

**Tests:**
- Vue Test Utils suite: small site renders flat; 1000+ page mock site renders hierarchy; search filters; virtualization activates above threshold; URL hash sync
- E2E: smoke test against the synthetic 5K fixture for tree open + search + select

**Why high risk:** the visible UX. Wrong hierarchy = author can't find pages. Wrong virtualization = scroll feels broken. Search misbehavior = author thinks pages are missing. Heavy on testing.

**SOLID:** SRP — `useSiteTreeData` owns fetching; component owns rendering. Composition not inheritance — virtualization is a wrapper, not a base class.

### Cut 10: ComponentTree.vue scale

**Files modified:**
- `apps/admin/src/client/components/ComponentTree.vue`:
  - Per-build fragment-resolution cache (Map scoped to one `watch` callback)
  - Virtualization at >100 rows (same library + threshold)
  - Depth-warning badge on nodes whose ancestry exceeds 5 fragment levels
  - 200-component banner above the tree when total component count >200

**Multi-instance constraint enforced**: cache lifetime is one watch callback. Test that ensures cross-build state doesn't leak.

**Tests:**
- Per-build cache collapses N fetches to N-unique
- Cache cleared between builds (state from build 1 doesn't leak to build 2)
- Depth warning fires at 6+ levels; doesn't fire at 5
- 200-component banner visible at 201, hidden at 200

**Risk:** medium. Cache scope bug = either no perf benefit (re-fetches) or staleness (cross-build leak).

### Cut 11: AssetLibrary.vue scale

**Files modified:**
- `apps/admin/src/client/components/AssetLibrary.vue`:
  - Cursor pagination consuming Cut 8's endpoint
  - Virtualized grid (`@tanstack/vue-virtual`)
  - `loading="lazy"` on `<img>` thumbnails (existing primitive; verify it's set)
  - Filter UI consumes `?kind=&tag=`

**Tests:**
- Bench: scroll-through-all latency under SLA at 20K assets
- E2E: filter narrows results; pagination loads more on scroll

**Risk:** medium. Grid virtualization with images is trickier than text rows (image height varies before load → layout shift). Use fixed-aspect thumbnail boxes.

### Cut 12: Compare/Publish dialogs

**Files modified:**
- `apps/admin/src/client/components/PublishPanel.vue` (or wherever compare results render):
  - <200 changed items → existing flat list
  - ≥200 → summary view: `{ added: N, removed: M, modified: K }` with per-group expand-to-detail
- Multi-target picker: virtualize when target count > 100 (rare in practice)

**Tests:**
- Compare with 50 changed items → flat list (visual sanity)
- Compare with 500 changed items → summary view with correct counts
- Expand "modified" group → renders the 200+ items

**Risk:** low. Existing dialogs work; this cut adds a threshold-driven branch.

### Cut 13: Docs

**Files added/modified:**
- `docs/scale.md` (NEW) — operator guide; envelope table; tuning tips (concurrency, cache provider choice); regression-detection workflow
- `ROADMAP.md` — mark scale design pass status as Tier 3 implementation
- `CLAUDE.md` — link `docs/scale.md` from the public docs section

## Validation gate (definition of done)

- [ ] All 13 cuts merged
- [ ] Bench suite green at 5000 pages: cold p99 ≤ 150ms warm; ≤ 10ms warm
- [ ] Bench suite green at 20000 assets: paginated p99 ≤ 200ms cold
- [ ] Tree, asset library, compare/publish all functional at synthetic envelope
- [ ] Nightly perf-regression CI gate active
- [ ] No multi-instance regression: per-build caches stay per-build; tested via two-instance harness

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Per-edge sidecar page index (`.gazetta/page-index/{prefix}/{name}`) | Sites cross 10K pages and filesystem-walk latency crosses SLA |
| Faceted browse navigation (alternative to tree) | After `design-rendering.md`'s render-time queries / filtered listings ship |
| Two-pane navigator (favorites / recents) | Operators report finding-the-same-pages-repeatedly pain |
| Enterprise-tier envelope (50K+ pages / 200K+ assets) | Concrete operator demand at the boundary |
| Per-locale search index | If locale-specific search quality issues surface |
| `posix_fadvise` / mmap StorageProvider extension | Micro-opt not justified at envelope |
| Deliberate OS-cache eviction control | Enterprise tier where cache pressure becomes a budget item |

## Open implementation questions

1. **Search debounce window.** Client-side filter for <1000 pages should be ~150ms debounce; server-side search should be ~300ms (extra round-trip budget). Confirm thresholds during cut 9 against real fixture.
2. **Virtualization library final pick.** `@tanstack/vue-virtual` v3 is the recommendation; verify Vue 3.5 compat + bundle size at cut 9 implementation time.
3. **Cursor encoding format.** Base64-encoded JSON `{ lastName, sortKey }` is the proposed shape. Property-based test ensures stability across iteration; final encoding format locked at cut 8.
4. **Search index freshness on cloud sources.** Filesystem-backed sites: search walks fresh on every call (fast). Cloud-backed sites: search walks once warm-cached, invalidated on save. Document the trade-off in `docs/scale.md`.

## Estimates

Wall-clock for solo dev with normal CI iteration:

| Cut | Estimate |
|---|---|
| 1 (Bench scaffolding + CI) | 1.5 days |
| 2 (Provider concurrency) | 0.5 day |
| 3 (`/api/pages` prefix shard) | 1.5 days |
| 4 (`/api/pages/search`) | 1 day |
| 5 (Cache + invalidation paired) | 1.5 days |
| 6 (Boot warm) | 0.5 day |
| 7 (`/api/fragments` mirror) | 1 day |
| 8 (`/api/assets` pagination) | 1.5 days |
| 9 (SiteTree.vue) | 3 days |
| 10 (ComponentTree.vue) | 1.5 days |
| 11 (AssetLibrary.vue) | 2 days |
| 12 (Compare/publish dialogs) | 1 day |
| 13 (Docs) | 1 day |

**Total: ~17 days.** Budget ~3-4 weeks with iteration on the visible UX cuts (9, 10, 11) where Vue + virtualization library quirks tend to absorb time.

## SOLID checks per cut

- **Cut 1**: SRP — fixture generator, bench suite, CI workflow are three files with one concern each.
- **Cut 2**: ISP — `recommendedConcurrency` is a numeric field, not a capability interface every provider must implement methods for.
- **Cut 3, 7, 8**: SRP per route module; OCP via the schema layer (additions don't change existing fields).
- **Cut 5**: DIP — admin-api consumes `AdminCache` (interface), not `MemoryCache` directly; multi-instance providers slot in without consumer changes.
- **Cut 9**: SRP — `useSiteTreeData` composable owns fetching; component owns rendering; virtualization is a wrapper, not inheritance.
- **Cut 10**: ISP — fragment cache is local to one watch callback; doesn't expose a shared API.
- **Cut 11**: SRP — pagination logic in a composable peer to `useSiteTreeData`; component renders.
- **Cut 12**: OCP — threshold-driven branch is additive; existing flat-list path stays.
