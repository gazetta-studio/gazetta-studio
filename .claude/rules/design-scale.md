---
paths:
  - "apps/admin/src/client/components/SiteTree.vue"
  - "apps/admin/src/client/components/ComponentTree.vue"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/assets.ts"
---

# Scale

Foundational dimension #1 of 12. Establishes the operating envelope (target N pages / M assets / K components-per-page) and the strategies for primitives that must hold at scale.

**Status**: design pass complete (2026-05). Implementation phases sit in Tier 3 unless individual primitives surface in feature-driven work.

**Companion docs**: [`feature-design-process.md`](feature-design-process.md) — defines the **Scale check** every new feature design must answer.

## Why this is foundational

Scale isn't a feature; it's a dimension every other feature must respect. Designing primitives at small-site assumption forces structural rework when a real operator brings a 1000-page / 5000-asset site. Some current primitives are scale-aware (per-edge sidecars, save-delta validation); others are not (site tree renders flat list of all pages, `/api/pages` returns everything in one response, asset library, compare/publish dialogs).

## Locked invariants (already decided)

These dimension-level decisions are locked, even before the design pass formalizes them:

- **Per-edge sidecars over aggregate JSON** — the asset-refs index uses `.gazetta/asset-refs/{asset}/{item}` zero-byte files rather than `.refs/{asset}.json`. Multi-instance correct, O(1) writes per edge, O(N) readDir on lookup. Same pattern for `.uses-*` and `.tpl-*` sidecars. Per [`design-media-implementation.md`](design-media-implementation.md) "Asset refs."
- **Save-delta validation over save-full** — save handlers validate only refs introduced by THIS edit, not the whole site. Per [`design-validation.md`](design-validation.md). O(diff) instead of O(site).
- **History uses content-addressed blobs** — unchanged items dedupe across revisions. Per [`design-publishing.md`](design-publishing.md) "History." Storage scales with unique content, not revision count.

## Exploited host-OS behavior

Beyond our own primitives, scale strategies lean on the **host filesystem cache** (Linux page cache, macOS unified buffer cache, Windows cache manager). The OS aggressively caches recent file reads in RAM; we exploit this rather than caching at the application layer for some operations.

**Concrete reliances:**

- **Cold-vs-warm latency model.** A 5000-page filesystem walk is ~150ms cold, ~10ms warm. Our boot-warm strategy populates the OS cache in addition to `AdminCache`, so the next admin instance booting on the same host (or the same instance restarting) sees warm reads.
- **Sidecar size discipline.** Per-edge sidecars are zero-byte or <1KB on purpose — small files fit in OS cache pages efficiently; readDir + parallel small reads stay near-memory-speed once warm.
- **Concurrency tuning differs cold vs. warm.** Provider-aware concurrency (locked above) targets cold-read SLA; warm reads need lower concurrency because the OS cache absorbs them serially fast enough.
- **Multi-instance considerations.** OS cache is per-host. Instances on the same host share it (reduce redundant cold reads); instances on different hosts don't (each pays its own cold read once). Hot-host effects observable in benchmarks; not exploitable for cross-instance coordination.

**Not exploited (out of scope for this design):**

- **OS-level prefetch hints** (`posix_fadvise`, etc.) — micro-optimization not yet justified at our envelope.
- **Memory-mapped reads** — would force an mmap-aware StorageProvider implementation; complexity exceeds gain for the read patterns we have.
- **Deliberate cache eviction control** — we let the OS manage; relevant only at enterprise tier where cache pressure becomes a budget item.

This is a documented dependency, not a managed system. Cloud-storage-backed sources (R2, S3, Azure) don't get OS filesystem cache; they get HTTP-level caching from the SDK plus our `AdminCache` on top. The two paths converge at the storage-provider abstraction.

## Site tree strategy (locked)

**Strategy: hierarchical tree + on-demand virtualization + always-on search** — the hybrid composition. Holds at every scale: small sites browse, large sites search, mixed sites do both.

Locked decisions:

- **Hierarchical structure** derived from route path. Pages at `/blog/*` group under a synthetic `blog/` node. Top-level pages stay top-level. Dynamic-route pages (`blog/[slug]`) render as a single node with an instance-count badge; expanding shows matched instances.
- **Search box** at the tree top. Case-insensitive substring match on name + route + title metadata. Default = client-side filter; server-side search opt-in for sites above 1000 pages where client-side becomes slow. Search results render flat, regardless of hierarchical context.
- **Virtualization** kicks in only when a single rendered branch exceeds ~100 visible rows. Below threshold, naive render keeps the tree feeling immediate. Library candidate: `@tanstack/vue-virtual` v3 (final pick during implementation).
- **Path-based navigation memory** — selection updates URL hash; browser back/forward works.

**Why this composition** — naive flat rendering breaks at our 5000-page target; pure virtualization makes scroll-bar useless for navigation; search-only is hostile to small sites; hierarchical-only breaks when many flat children share a parent. The hybrid is the only shape correct at every scale, and each component is additive on existing primitives (current tree's filter input already does small-scale search; routes already encode hierarchy; virtual scrolling is a library drop-in).

**Graceful degradation** — at 50 pages, no virtualization fires and search returns instantly; at 5000 pages, all three engage. Same code, same UI, scale-transparent.

Closes issues: #88 (nested route tree + search at scale), #196 (large-site editor profile).

## Other primitives — locked

Categorized by primitive:

### Component tree (ComponentTree.vue) — locked

**Strategy: virtualization + per-build fragment cache + depth warning.**

The bottleneck at scale isn't DOM row count (modest even at 200 rows) — it's parallel `@fragment` fetches during tree-build. Caching fragment resolutions within one build pass collapses N fetches to N-unique. Virtualization handles the row-count edge case. Depth warning catches the rare design smell.

Locked decisions:

- **Per-build fragment-resolution cache** scoped to one `watch([detail, effectiveComponents])` callback. Map of `fragmentName → resolved-manifest`; cleared between builds. **Multi-instance constraint locked**: cache MUST stay per-build scope; cross-build / per-session / server-side caching is forbidden — it would violate the multi-instance discipline (admin running on multiple instances would have divergent caches that drift out of sync without invalidation infrastructure).
- **Virtualization** at the ~100-row threshold (same library, same threshold as the site tree). Below threshold, naive render preserves immediate feel.
- **Depth warning** at fragment-nesting depth > 5 — surfaces in the tree as a "deep nesting" badge on the affected node. Information, not a gate. Operators with legitimate depth > 5 can ignore.
- **Hard 200-component banner** for pages exceeding the per-page component limit. "200+ components — consider splitting into fragments." Tree still renders.

**Why not search on component tree** — component tree's mental model is "this page's structure," not "find a component." Adding search imports site-tree complexity for a problem most authors don't have. The 90th-percentile page has <20 components; structure-as-navigation works fine.

### Admin API — locked

**Strategy: prefix-sharded endpoints + dedicated search endpoint + provider-aware concurrency + boot warm.**

Divide-and-conquer applied. Each prefix is an independent shard; the tree's hierarchical UX (Q2) consumes prefix-shards naturally. Search is a separate endpoint for cross-prefix queries. Server walks filesystem with provider-tuned concurrency; warmed at boot for cloud-backed sources.

Locked endpoints:

- **`GET /api/pages`** (no params) — returns top-level pages + the prefix-shard list with page counts. Small (~5 KB at 5000 pages).
- **`GET /api/pages?prefix=blog/`** — returns pages under a prefix with summary fields (`name`, `route`, `template`, `locales`, `updatedAt`). Per-prefix loading on tree expand. ~30-150 KB per prefix.
- **`GET /api/pages/search?q=foo`** — server walks all pages with substring match; returns matches. Typically <100 KB. Server-side because filesystem walks at 5000 pages are fast (~150ms cold) and shipping the full set client-side is wasteful.
- **`GET /api/pages/:name`** — unchanged; per-page detail fetched on selection.
- **`GET /api/fragments`** — same prefix pattern, smaller scale.
- **`GET /api/dependents`** — unchanged; already memoized per-process via source-sidecars pattern.

Locked performance machinery:

- **Provider-aware concurrency** — server's prefix walk uses `mapLimit` with concurrency derived from the storage provider. Filesystem: existing `DEFAULT_CONCURRENCY = 20`. Cloud (R2, S3, Azure): higher (~100), bounded by FD + rate-limit budgets. Provider exposes `recommendedConcurrency` as part of the `StorageProvider` interface.
- **Caching via `AdminCache`** — endpoints cache prefix-summary and search results through the `AdminCache` abstraction (per `design-cache.md`). v1 = `MemoryCache` provider (per-instance, multi-instance-correct via independence). Cache key includes storage-state hash; invalidates on save/publish events.
- **Eager warm at boot** — admin server warms top-level pages + the prefix list during boot. On filesystem (~100ms), invisible. On cloud-backed source (~300ms-1s), eliminates first-request latency for the most common admin tab open.

**Multi-instance discipline holds:**
- Endpoints are stateless reads of storage; no cross-instance coordination.
- `AdminCache` v1 = `MemoryCache` per-instance scope; eventual consistency across instances acceptable for read-heavy paths.
- Future shared cache providers (Redis, Azure storage) reduce cross-instance staleness without changing endpoint contracts.

**Future migration path (Tier 3 enterprise tier):** when sites cross 10K pages and filesystem-walk latency crosses the SLA bar, add per-edge sidecar index pattern (`design-media-implementation.md` asset-refs lineage) — `.gazetta/page-index/{prefix}/{name}` zero-byte files maintained at save time. Reindex CLI handles drift. Multi-instance-correct via the same granularity rule. The current contract (`/api/pages?prefix=`) is forward-compatible; the storage/lookup layer changes underneath, the endpoint stays the same.

### Asset library — locked

**Strategy: paginated + filtered endpoints, virtualized grid, lazy thumbnail loading.**

- **`GET /api/assets`** — paginated, default 100 per page, cursor-based. Returns summary fields per asset (name, kind, mime, dimensions, alt-default, locales).
- **`GET /api/assets/search?q=&kind=&tag=`** — server-side filter; returns matches. Combine query params for compound filters (e.g., `?kind=image&tag=hero`).
- **`GET /api/assets/:name`** — unchanged; per-asset detail.
- **Library UI**: virtualized grid (same library + threshold pattern as the trees). Thumbnails lazy-load on visibility via existing `loading="lazy"` attribute.
- **Cache via `AdminCache`** with the same pattern as `/api/pages` — page-keyed entries, invalidates on asset save/delete events.
- **Thumbnails** are content-hashed assets generated at upload time per `design-media.md` (already O(1) lookup); no scale concern.

Multi-instance discipline: paginated reads are stateless. Cursor is a stable encoding of "where in the listing"; doesn't depend on shared state.

### Compare / publish dialogs — locked

**Strategy: limit list rendering at threshold, summary view above the limit.**

- **Compare endpoint** (`GET /api/compare?from=&to=`) currently returns the full diff. At 5000 pages with 500 changed = 500-entry list. Below ~200 changed items, render full list; above threshold, render a **summary view** (group by status: added / removed / modified) with expand-to-detail per group.
- **Publish picker** virtualizes when item count > 100 (consistent with tree threshold).
- **Multi-target fan-out picker** stays small in practice (operator-configured target count is bounded per envelope at 10 / hard limit 25); no changes needed.
- Server walks for compare use provider-aware concurrency.

### Background scanner (validation Cut 2) — locked

**Strategy: incremental rescan + per-page content-hash cache + sidecar-aware invalidation.**

Already covered in `design-validation.md`'s scale check. Recap:

- Initial scan at admin boot — uses provider-aware concurrency to walk all pages in parallel; populates `AdminCache` (validation-results entries keyed by `content-hash + dependency-hash`).
- Incremental rescan on file watcher events — fragment edit invalidates affected pages via `findDependentsFromSidecars` (existing primitive); only affected pages re-validate.
- Multi-instance: each instance scans independently; cache is per-instance via `MemoryCache` (or shared via `RedisCache` when an operator opts in).
- SLA: initial scan completes in <30s on filesystem-backed source at 5000 pages; <5min on cloud-backed source. Acceptable as boot-time work since it's parallelized and admin remains responsive on cached data.

### Profile / measurement — locked

**Strategy: fixture site at target scale + benchmark suite + perf-regression CI.**

- **Fixture site generator** — extend the existing `synthetic-site.ts` helper (`packages/gazetta/tests/_helpers/synthetic-site.ts`, used today for media-perf benchmarks) to emit a 5000-page site with realistic shape. Reuse the helper's deterministic-seed pattern so benchmarks are reproducible.
- **Benchmark suite** — `npx vitest bench` against the synthetic site. Targets: `/api/pages` cold/warm, `/api/pages?prefix=`, `/api/pages/search?q=`, `/api/assets` paginated, save-delta validation, background-scan boot. Each benchmark records p50/p95/p99 latency.
- **CI gate** — nightly run on the perf branch (similar to existing mutation-testing nightly). Regressions above the baseline threshold (10% perf drop OR p99 above SLA) fail the run.
- **Manual operator profiles** — separate `./scripts/profile-site.sh` runs the fixture generator + benchmarks once for ad-hoc regression hunting.

## Foundational checks

This design IS a foundational dimension. Below it answers how every other foundational dimension and discipline composes with scale; the design pass formalizes what's still open.

- **Multi-instance check** (discipline) — every primitive at scale must respect the multi-instance constraint. Per-build caches are in-process scope only; cross-instance coordination uses storage-granularity (per-edge sidecars, content-addressed blobs). Tree virtualization is per-browser; pagination cursors are stateless; search indexes are per-storage (or external). No primitive may rely on a shared in-memory cache across admin instances.
- **Theme check** — virtualization + search apply uniformly across themes; tree-build cost is theme-independent. Locale-priority cross-dimension fallback applies inside any theme variant the tree might preview.
- **Locale check** — site tree shows pages with their default-locale label; locale switch re-fetches manifests in the active locale. Search index is per-locale OR locale-agnostic (decided in design pass).
- **Team check** — per-role visibility filters the tree (an editor without read-access to `/private/*` doesn't see those pages). Filter applied at `/api/pages` query time, not client-side, so 5000 pages don't ship to clients lacking access.
- **Hook check** — tree-build doesn't fire hooks; tree is a read surface. Save/publish hooks compose elsewhere.
- **Render check** — render-time queries (filtered listings per `design-rendering.md`) and render-for-analysis (validation Cut 3) must hold at envelope scale; their cache keys include all dimensions.
- **Validation check** — background scanner (validation Cut 2) iterates pages incrementally with per-page content-hash cache; full-site rescan is admin-boot-only. Reuses the existing sidecar dependency tracking so a fragment edit invalidates only affected pages.
- **Plugin check** — plugin-contributed extension surfaces (custom validators, custom transform adapters, etc.) operate within the operating envelope; plugins that perform O(N) work per primitive are flagged at design time.
- **Cache check** — every primitive that benefits from caching at scale (notably `/api/pages` summary, `/api/fragments` summary, fragment-resolution within tree-build) goes through `AdminCache` per `design-cache.md`. v1 ships `MemoryCache` provider; per-instance scope, multi-instance-correct via independence + SSE invalidation. Operators on multi-instance deployments switch to a shared provider (Redis, Azure storage) for higher hit rates without changing consumer code.
- **Offline check** — primitives at scale must degrade gracefully when offline (per `design-offline.md`). Tree-build serves from browser-side `IndexedDBCache`; admin API endpoints return 503 with the staleness banner; save-delta validation continues to run locally; reconnect replays queued saves. Boot-warm strategy populates IndexedDB cache in addition to MemoryCache so first offline encounter has hot data.

## Operating envelope (the supported scale)

Gazetta targets a **standard production site** envelope. Locked:

| Dimension | Target (designed for) | Hard limit (degraded UX above) |
|---|---|---|
| Pages per site | 5000 | 10,000 |
| Assets per site | 20,000 | 50,000 |
| Components per page | 50 | 200 (deeply nested = warn) |
| Fragments per site | 500 | 1000 |
| Locale variants per page | 20 | 50 |
| Targets per site | 10 | 25 |

Every primitive's strategy must hold at the **target** column. The **hard limit** is where the UX visibly degrades but the system still functions — operators above the hard limit see explicit warnings and may need configuration tuning. Above the hard limit, behavior is undefined.

**Why this envelope, not bigger:** matches the team-CMS positioning (PR #227's strategic commitment) and the standard CMS scale (Sanity, Contentful, Storyblok target ~this range). Going larger means designing for hypothetical scale ahead of real operator demand — same trap as the plugin design grilling identified.

**Enterprise offering** (50K+ pages / 200K+ assets) is reserved for a future Tier 3 design pass when concrete operator demand surfaces. Strategies in this design pass are forward-compatible — none preclude a future enterprise tier; they just don't optimize for it.

## Migration

Existing sites are all small-site. Scale-aware primitives can be additive (paginated `/api/pages` with full-set as the default, virtualized tree behind a flag, etc.). The design pass's migration section formalizes how operator sites grow.

## Future directions

**Enterprise-scale envelope.** 50,000+ pages / 200,000+ assets / multi-million blobs. Today, no concrete demand. The envelope chosen here is forward-compatible — none of the strategies preclude a future enterprise tier; they just don't optimize for it. Trigger to revisit: a real operator pushes the boundary.

**Faceted browser as alternative navigation paradigm.** Sanity Studio works this way: sidebar shows filters (locale, status, template, last-modified, target-readiness); main pane shows the filtered set; the tree is one of several views. Strategically interesting — at scale, faceted browse outperforms tree-walking for "find me all pages tagged 'X' that haven't been published to prod" workflows.

Reserved for a future Tier 3 design pass after `design-rendering.md` ships render-time queries / listings. Filtered listings power the faceted browse; the design pass formalizes faceted as an alternative author-navigation mode alongside the tree, not a replacement.

**Two-pane navigator (favorites / recents).** Power-user shortcut: persistent "recently edited" pane on top of the tree. Doesn't solve scale (the tree below still has to handle 5000 pages), but adds genuine convenience for daily-use workflows. Trigger to revisit: operators report finding-the-same-pages-repeatedly pain.
