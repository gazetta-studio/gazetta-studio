---
paths:
  - "apps/admin/src/client/components/SiteTree.vue"
  - "apps/admin/src/client/components/ComponentTree.vue"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/assets.ts"
---

# Scale — design pass pending

Foundational dimension #1 of 8. Establishes the operating envelope (target N pages / M assets / K components-per-page) and the strategies for primitives that must hold at scale.

**Status**: design pass pending — sequenced 1 of 8 (after Validation Cut 1 ships). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**: [`feature-design-process.md`](feature-design-process.md) — defines the **Scale check** every new feature design must answer.

## Why this is foundational

Scale isn't a feature; it's a dimension every other feature must respect. Designing primitives at small-site assumption forces structural rework when a real operator brings a 1000-page / 5000-asset site. Some current primitives are scale-aware (per-edge sidecars, save-delta validation); others are not (site tree renders flat list of all pages, `/api/pages` returns everything in one response, asset library, compare/publish dialogs).

## Locked invariants (already decided)

These dimension-level decisions are locked, even before the design pass formalizes them:

- **Per-edge sidecars over aggregate JSON** — the asset-refs index uses `.gazetta/asset-refs/{asset}/{item}` zero-byte files rather than `.refs/{asset}.json`. Multi-instance correct, O(1) writes per edge, O(N) readDir on lookup. Same pattern for `.uses-*` and `.tpl-*` sidecars. Per [`design-media-implementation.md`](design-media-implementation.md) "Asset refs."
- **Save-delta validation over save-full** — save handlers validate only refs introduced by THIS edit, not the whole site. Per [`design-validation.md`](design-validation.md). O(diff) instead of O(site).
- **History uses content-addressed blobs** — unchanged items dedupe across revisions. Per [`design-publishing.md`](design-publishing.md) "History." Storage scales with unique content, not revision count.

## Open questions for the design pass

Categorized by primitive:

### Site tree (SiteTree.vue)
- Target N — what's the supported page count? 1000? 5000? 10,000?
- Virtualization strategy — virtual scrolling? expand-on-demand? search-driven flat list?
- Search-as-default — should search be the primary navigation primitive at scale, with the tree as a secondary affordance?
- Nested route paths (#88) — how to render nested routes (e.g., `blog/[slug]`) so they collapse intuitively without hiding genuinely-different pages?

### Component tree (ComponentTree.vue)
- K components per page — supported? 50? 200?
- Deeply-nested fragments — render time grows with depth (recursive resolve); cap or warn?

### Admin API
- `/api/pages` returning all pages — paginate? 100 per page? cursor-based?
- `/api/fragments` similarly?
- `/api/dependents` — already O(N) walk on first call, memoized; check it scales

### Asset library
- M assets per site — supported? 1000? 10,000?
- Pagination + filter — required at what threshold?
- Thumbnail generation cost — pre-generated at upload, O(1) lookup; check it holds

### Compare / publish dialogs
- Hundreds of changed items — how does the picker stay usable?
- Multi-target fan-out picker — how does it behave with many destinations?

### Background scanner (validation Cut 2)
- Per-page validation cache invalidation cost at 1000 pages
- Initial-scan time on admin boot — incremental?

### Profile / measurement
- What's the test infrastructure? — fixture site at target scale (e.g., generated 5000-page site) for performance regression detection
- What metrics matter? — first-load time, search latency, save latency, publish latency

## Concrete operator targets to size against

(To be decided in the design pass — but for now, working assumptions:)

- **Small site**: <100 pages, <500 assets, <20 components/page (current implicit target)
- **Medium site**: 100-1000 pages, 500-5000 assets, <50 components/page
- **Large site**: 1000-10,000 pages, 5000-50,000 assets, <100 components/page

The design pass picks a supported envelope and documents both the strategies and the limits.

## Migration

Existing sites are all small-site. Scale-aware primitives can be additive (paginated `/api/pages` with full-set as the default, virtualized tree behind a flag, etc.). The design pass's migration section formalizes how operator sites grow.

## Future directions

Beyond this design's envelope: 100,000-page sites, multi-million-asset libraries. Today, no concrete demand. The envelope chosen here can extend later if a real operator pushes the boundary.
