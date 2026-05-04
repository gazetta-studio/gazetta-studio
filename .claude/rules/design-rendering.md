---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/resolver.ts"
  - "packages/gazetta/src/serve.ts"
  - "packages/gazetta/src/publish-rendered.ts"
  - "packages/gazetta/src/admin-api/routes/preview.ts"
  - "packages/gazetta/src/types.ts"
---

# Rendering modes — design pass pending

Foundational dimension #8 of 12. The full taxonomy of when and where rendering happens: static (pre-rendered), ESI (assembled at edge from pre-rendered fragments), request-time SSR (templates execute per request), island (SSR'd + hydrated in browser). Plus listings / render-time queries.

**Status**: design pass pending — sequenced after `design-themes.md` (depends on locale + theme as render-context). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Render check** every new feature design must answer
- [`design-publishing.md`](design-publishing.md) — current static + ESI render flows
- [`design-concepts.md`](design-concepts.md) — component rendering types (static / dynamic / island)
- [`design-i18n.md`](design-i18n.md) — locale enters render context
- [`design-themes.md`](design-themes.md) — theme enters render context

## Why this is foundational

The rendering taxonomy currently lives implicitly across `design-publishing.md` and `design-concepts.md`. Pulling it into one foundational doc means: future features that touch the render pipeline reason about all four modes (static / ESI / request-SSR / island) uniformly.

Issue #80 (dynamic route params at render) is a sub-task of this design pass — params plumbing is part of the request-time SSR contract, not a standalone fix.

## Locked invariants (already decided)

- **Compose vs. resolve verb split** — composing a tree from references is `compose*`; picking a value from a fallback chain or merging layered config is `resolve*`. Per [docs/adr/0001-compose-vs-resolve-verb-split.md](../../docs/adr/0001-compose-vs-resolve-verb-split.md).
- **Hash-in-path URLs for assets** — content-addressed; URL changes when bytes change. Per [`design-media.md`](design-media.md).
- **Content-addressed dedupe at publish** — unchanged items skip re-render via hash sidecars. Per [`design-publishing.md`](design-publishing.md).
- **Logical comparison only** — compare operates on logical content, not materialized output. Per [`design-decisions.md`](design-decisions.md) #17.

## Open questions for the design pass

### Multi-instance check
- Static and ESI modes already multi-instance-safe — published HTML lives in storage; any instance reads it.
- Request-time SSR: render context (params, cookies, principal) is per-request; no cross-instance state. Multiple SSR instances render the same page identically given the same context.
- Render-for-analysis cache (validation Cut 3) — per-request OR per-build, never shared in-memory across instances. The cache key includes content + dependency hashes so different instances arrive at the same cache entry without coordination.
- Listings / render-time queries — read from storage on each request; pagination cursors are stateless. No shared in-memory query cache.
- Import maps for islands — derived from the published assets directory; computed per-render, never cached cross-instance.

### Render mode taxonomy
- Three modes today (static / ESI / island) — adding request-SSR makes four. Naming clarity — does "dynamic" stay an alias for ESI, or get repurposed for request-SSR? Or both as separate target types?
- Component rendering types vs. target types — orthogonal axes? A static target can have an island component; can a request-SSR target have a static component?

### Request-time SSR
- Render context shape — `{ params, headers, cookies, principal, locale, theme }`?
- Execution environment — Node/Bun only (templates need full Node)? WASM hybrid? Worker-runnable subset?
- Caching — per-request output usually not cacheable; per-(params, principal) cache? Cache-busting?
- Auth gate at render time — RBAC composes with render to filter content per role
- Timeout / fallback — slow template? Fallback to static? Timeout error?
- Issue #80 — params plumbed through `c.req.param()` → render context. Implementation lands as part of this design pass's implementation phase.

### Listings / render-time queries
- Templates need to enumerate "all blog pages" or "all pages with tag X" at render time. What's the API?
- Composes with locale (filter by locale), theme (filter by theme), RBAC (filter by viewer's role)
- Pagination, sort order, search-as-render-time-query
- Replaces what Algolia would do for filtered listings (full-text site-search stays delegated per non-goals)

### Routes
- Static / dynamic route discovery — current model: filesystem-based folder structure
- Request-SSR routes — same? Or template-declared?
- Custom routes (plugins) — how do they fit? Per `design-plugins.md`

### Composition with other dimensions
- **Locale**: render context carries locale; composition with locale-variant manifests already shipped
- **Theme**: render context carries theme; needs `design-themes.md` to formalize
- **RBAC**: render-time auth gate; permission-filtered output
- **Hooks**: render-time hooks for output transformation
- **Validation**: render-for-analysis (validation Cut 3) is a render mode variant

### Edge runtime constraints
- WinterTC (Cloudflare Workers, Deno Deploy) — can run static + ESI; can NOT run templates that need Node
- Node/Bun (gazetta serve) — can run all modes
- Hybrid — split by mode, edge for static + ESI, Node for request-SSR + island origin

## Migration

Existing sites use static + ESI today. Request-SSR is opt-in via target config. Existing static pages stay static unless explicitly promoted.

## Future directions

- Streaming SSR (HTTP streaming response) — out of scope for v1; depends on per-render perf measurement
- Edge SSR with WASM-compiled templates — out of scope; edge-runtime constraints are real today
- Server components (RSC-style) — strategic bet; not on roadmap
