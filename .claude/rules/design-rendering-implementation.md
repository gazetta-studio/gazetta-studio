---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/types.ts"
  - "packages/gazetta/src/workers/**"
  - "packages/gazetta/src/runtime/**"
  - "packages/gazetta/src/admin-api/routes/preview.ts"
  - "packages/gazetta/src/cli/serve.ts"
---

# Rendering — Implementation

Companion to [design-rendering.md](design-rendering.md). Cut sequence with risk ordering.

See [design-rendering.md](design-rendering.md) for the design itself.

## Status

Today's codebase ships only the `static` and `esi` target types (the `esi` target type uses string-cat composition via Hono on workers; `static` ships pre-assembled HTML). The locked v1 design adds:

1. The `dynamic` target type (origin Node/Bun process; per-request template execution)
2. Fragment-level `rendering: 'static' | 'dynamic' | 'island'` declaration
3. Programmatic `pages.where(...).list()` listings API for templates
4. Three route modes (static, static-with-params, dynamic)
5. `RenderContext` per-request object for dynamic fragments
6. Per-fragment `timeout` + `onFailure` modes

Several open threads are flagged in `design-rendering.md`'s "More grilling needed" — those need a follow-up grilling pass. The cuts below proceed with the locked invariants and call out the provisional ones.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `rendering-v1` off `main`. **No backwards compatibility** — `esi` target stays the current default and works unchanged; `static` and `dynamic` are net-new (static was previously documented but unwired in some paths).

Sequenced server-first (contracts + listings + route discovery), then worker / origin runtime, then UX surfaces (admin preview, sitemap). Risk-ordered: low-risk type/schema changes first; high-risk worker/origin protocol last.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `TargetConfig.type` enum + Zod schema; current `esi` config remains as the default; `static` and `dynamic` opt-in | ☐ | Low | Type contract |
| 2 | `RenderContext` shape locked + plumbed into renderer | ☐ | Medium | Per-request state |
| 3 | `pages.where(...).list()` + `fragments.where(...).list()` — programmatic listings API at publish time (helpers param) | ☐ | High | New template surface |
| 4 | Listings caching via `AdminCache` + invalidation on save | ☐ | Medium | Cache contract on listings |
| 5 | Fragment-level `rendering` declaration + validator coherence check (template signature ↔ manifest field) | ☐ | Medium | Fragment-rendering-type contract |
| 6 | `routes.json` route manifest + 3 route modes (static / static-with-params / dynamic) + conflict detection | ☐ | High | Route discovery |
| 7 | Per-fragment `timeout` + `onFailure` (`empty` / `placeholder` / `fail-page`) + audit integration | ☐ | Medium | Failure modes |
| 8 | `dynamic` target origin runtime: template execution per request, `RenderContext` populated, response shape | ☐ | High | The new target type |
| 9 | Worker → origin protocol for dynamic fragments (HTTP-based; per-fragment fetch with `RenderContext` payload) | ☐ | High | Cross-process boundary |
| 10 | Worker cache rule: content-addressed responses only; dynamic responses pass through with origin's `Cache-Control` | ☐ | Medium | Cache correctness |
| 11 | Admin preview supports dynamic targets (calls origin in-process during dev) | ☐ | Medium | Preview parity |
| 12 | Sitemap + hreflang for dynamic routes (route enumeration from `routes.json`) | ☐ | Low | SEO surface |
| 13 | Per-platform deployment matrix verified: Cloudflare + Fly.io split; Node/Bun single-process | ☐ | Medium | End-to-end validation |
| 14 | Docs (`docs/rendering.md` operator + template-author guide) + ROADMAP + CLAUDE.md | ☐ | Low | User-facing |

Provisional locks flagged in design-rendering.md's "More grilling needed" need resolution before cut 5 (fragment-rendering-type), cut 6 (route discovery), and cut 9 (worker→origin protocol). Each is a small follow-up grilling pass; documented per cut below.

## Per-cut scope

### Cut 1: Target type enum

**Files modified:**
- `packages/gazetta/src/config/schemas.ts` — `targetSchema.type` is now a closed enum: `z.enum(['static', 'esi', 'dynamic']).default('esi')` (esi stays the default for backwards compat at the schema level)
- `packages/gazetta/src/types.ts` — `TargetConfig.type: 'static' | 'esi' | 'dynamic'`
- `packages/gazetta/src/site-loader.ts` — pass through; Zod handles default

**Tests:**
- Default: target without `type` resolves to `esi`
- `'static'` resolves directly; `'dynamic'` resolves directly
- Unknown type rejected with helpful error

**Risk:** low. The field is additive; existing configs default to `esi`.

**SOLID:** ISP — `type` is a single field, not a capability interface. Each target type's behavior lives in its own runtime module.

### Cut 2: `RenderContext` plumbed

**Provisional lock to resolve before this cut**: design-rendering.md item #5 ("`RenderContext` shape lock"). Recommended fields: `{ params, query, headers, cookies, principal, locale, theme, target, requestId, now }`. A 1-day grilling pass to confirm field set + types.

**Files modified:**
- `packages/gazetta/src/types.ts` — `RenderContext` interface with the locked fields
- `packages/gazetta/src/renderer.ts` — accept optional `ctx: RenderContext`; pass to dynamic fragment templates as `params.ctx`; static + island templates don't receive `ctx`
- Static + island template signature: existing `(params: { content, children?, locale, theme })` — unchanged
- Dynamic fragment template signature: `(params: { content, children?, ctx })` — `locale` and `theme` accessible via `ctx.locale` / `ctx.theme`

**Tests:**
- Static template invoked without `ctx` → `params.ctx === undefined`
- Dynamic fragment template invoked with full `RenderContext` populated
- Property test: `RenderContext` shape immutable (frozen)

**Risk:** medium. Wrong shape forces template-author migration. Property tests guard the contract.

### Cut 3: Programmatic listings API

**Files added:**
- `packages/gazetta/src/runtime/page-query.ts` — `PageQuery` builder + filter/sort/limit/offset/list semantics
- `packages/gazetta/src/runtime/fragment-query.ts` — same shape for fragments
- `packages/gazetta/src/runtime/helpers.ts` — `createHelpers(site, locale, theme)` returns `{ pages: PageQuery, fragments: FragmentQuery }`

**Files modified:**
- `packages/gazetta/src/renderer.ts` — pass `helpers` to static + island templates; `ctx.pages` and `ctx.fragments` for dynamic templates
- Template signatures: `helpers` field present at publish time; `ctx` field for dynamic templates exposes the same query objects

**Locked composition rules** (per design):
- Locale: automatic filter by active locale; opt out via `where({ locale: 'all' })`
- Theme: automatic filter by active theme; opt out via `where({ theme: 'all' })`
- RBAC: at request time, automatic filter by `ctx.principal`'s read capabilities; at publish time, no filter (no principal)
- No free-text search — equality + sort only

**Tests:**
- Filter by `template`, `tag`, manifest field path → returns matching subset
- Sort + limit + offset (offset-based pagination per design pass)
- Locale filter active by default; opt-out works
- RBAC filter at request time excludes pages the principal can't read (verified via test principal lacking read access)
- Property test: query is deterministic (same inputs → same output)

**Risk:** high. New template surface; bugs here cause silent data leaks (e.g., RBAC filter not applied; cross-locale results showing up).

**SOLID:** SRP — `PageQuery` owns building the query; the filter implementation is a separate function. DIP — templates depend on the `PageQuery` interface, not on the filesystem walker.

### Cut 4: Listings cache

**Files modified:**
- `packages/gazetta/src/runtime/page-query.ts` — `list()` checks `AdminCache` first; on miss, computes + sets
- Save handlers (`pages.ts`, `fragments.ts`) — invalidate `pages-query:` and `fragments-query:` prefixes

**Cache key shape** per `design-cache.md` Q1: `pages-query:{filter-hash}:locale:{l}:theme:{t}:limit:{N}:offset:{M}`. Filter hash is sha256 of canonical-JSON-serialized filter object.

**Tests:**
- Same query twice → second call cache hit
- Save → next query is fresh
- Cross-locale queries don't share cache entries

**Risk:** medium. Wrong cache key = stale listings; tests guard via integration round-trip (save → query → assert fresh).

### Cut 5: Fragment `rendering` declaration

**Provisional lock to resolve before this cut**: design-rendering.md item #2 (explicit `rendering` field vs. inferred from template signature). Recommend explicit field; validator coherence check catches mismatch.

**Files modified:**
- `packages/gazetta/src/types.ts` — `FragmentManifest.rendering?: 'static' | 'dynamic' | 'island'` (default `'static'`)
- `packages/gazetta/src/validation/validators/fragment-rendering-coherent.ts` (NEW) — validator: template's TS signature (presence/absence of `ctx` parameter) matches manifest's `rendering`
- `packages/gazetta/src/renderer.ts` — branch on `fragment.rendering` to pick render-time + invocation shape

**Tests:**
- Default: fragment without `rendering` field treated as `'static'`
- `'dynamic'` fragment: template invoked at request time with `ctx`; not at publish time
- `'island'` fragment: template SSR'd at publish time; hydration script injected
- Coherence validator: signature mismatch reported with file path

**Risk:** medium. Wrong rendering branch = wrong invocation shape; templates fail at runtime. Coherence validator catches it at validation time.

### Cut 6: Route discovery

**Provisional lock to resolve before this cut**: design-rendering.md item #1 (dynamic routes vs. dynamic fragments). Locked: orthogonal axes; routes determine URL → page resolution; rendering determines per-fragment invocation timing.

**Files modified:**
- `packages/gazetta/src/types.ts` — `PageManifest.params?: { source: 'list' | 'query', values?: string[], query?: PageFilter }` and `PageManifest.dynamic?: boolean`
- `packages/gazetta/src/runtime/route-discovery.ts` (NEW) — discovers all routes at publish time; expands static-with-params; emits `routes.json` to target storage
- `packages/gazetta/src/runtime/route-conflicts.ts` (NEW) — detects two pages claiming same route, slug overlap, dynamic shadowing static (warn)
- `packages/gazetta/src/publish.ts` (or `publish-rendered.ts`) — call route discovery; bake `routes.json` into target

**Tests:**
- Static route → 1 entry in routes.json
- Static-with-params (list) with N values → N entries (one per value)
- Static-with-params (query) at publish time runs the query; entries match
- Dynamic route on `static` target → publish error
- Dynamic route on `esi` target → publish error
- Dynamic route on `dynamic` target → entry with `dynamic: true`
- Route conflict: two static routes same path → publish error
- Route shadow: dynamic shadows static → warning

**Risk:** high. Route discovery is the URL → page resolution contract. Wrong shape = 404s on routes that should resolve, or wrong page rendered.

### Cut 7: Per-fragment timeout + onFailure

**Files modified:**
- `packages/gazetta/src/types.ts` — `FragmentManifest.timeout?: number`, `onFailure?: 'empty' | 'placeholder' | 'fail-page'`, `fallbackHtml?: string`
- `packages/gazetta/src/runtime/fragment-failure.ts` (NEW) — handles each failure mode
- `packages/gazetta/src/audit/types.ts` — extend `action` enum with `'fragment-failed'` and `outcome` enum (per design-rendering.md "Audit integration")
- `packages/gazetta/src/admin-api/routes/audit.ts` (when audit ships) — surface fragment-failure events

**Tests:**
- Origin times out → `empty` mode emits HTML comment marker; page renders without the fragment
- `placeholder` mode renders `fallbackHtml`
- `fail-page` mode → 504 Gateway Timeout
- 5xx origin error → 502 Bad Gateway with `fail-page`
- Audit event fired with action+outcome

**Risk:** medium. The `fail-page` path is the operator-visible failure surface; wrong status code or missing audit = compliance gap.

### Cut 8: Dynamic origin runtime

**Files added:**
- `packages/gazetta/src/runtime/origin.ts` — origin Node/Bun handler; per-request template execution; `RenderContext` populated; response shape includes content-hash for worker caching of static parts (origin doesn't cache its own per-request output)
- `packages/gazetta/src/cli/origin.ts` (NEW) — `gazetta origin` CLI command (or extend `gazetta serve` to dual-role for single-process deployments)

**Tests:**
- Origin handler invoked with `RenderContext` → template returns `{ html, css, js, head }`
- Origin returns 200 with rendered output; per-request `Cache-Control: no-store` (origin doesn't cache; worker handles it)
- Multiple concurrent requests with different `RenderContext` produce isolated outputs

**Risk:** high. New runtime; new failure modes; new deployment topology. Heavy on tests + integration testing against real Cloudflare Workers + Fly.io.

**SOLID:** SRP — origin handler does one thing (execute template per request). DIP — origin depends on `StorageProvider` interface for content reads; doesn't reach into specific providers.

### Cut 9: Worker → origin protocol

**Provisional lock to resolve before this cut**: design-rendering.md item #4 (page composition with mixed-rendering fragments) and "Provisional — dynamic side needs more grilling" in Q5. ~2-day grilling pass to lock:
- HTTP-based per-fragment fetch shape (worker calls origin once per dynamic fragment? batched? per-page?)
- Cache key for dynamic responses with route params
- Hot-reload of routes (does worker pick up new dynamic routes at next request, or require redeploy?)

**Files added:**
- `packages/gazetta/src/workers/origin-client.ts` — worker-side HTTP client to origin; encodes `RenderContext` in request body
- `packages/gazetta/src/runtime/origin-server.ts` — origin-side request handler; decodes `RenderContext`; invokes template

**Files modified:**
- `packages/gazetta/src/workers/cloudflare.ts` (or composition logic) — branch on fragment.rendering; static fragments fetched from cache; dynamic fragments fetched from origin via origin-client
- Page composition assembly: string-concat with placeholder filling per design-rendering.md "Page composition model with mixed-rendering fragments"

**Tests:**
- Worker fetches static fragments from cache + dynamic from origin → composed page
- Origin failure → fragment-level fallback (Cut 7) applies
- Mixed page (static + dynamic + island) renders coherently

**Risk:** high. Cross-process protocol; bugs in encoding/decoding `RenderContext` cause silent data leaks or wrong rendering.

### Cut 10: Worker cache rule

**Files modified:**
- `packages/gazetta/src/workers/cache.ts` (or wherever worker cache logic lives) — only cache content-addressed responses (immutable hash-in-path URLs); dynamic origin responses pass through with origin's `Cache-Control` headers

**Tests:**
- Static fragment cached; same URL second request → cache hit
- Dynamic fragment NOT cached by worker; second request → fresh origin call (or origin-honored cache)
- Origin sets `Cache-Control: max-age=60` → worker honors via standard HTTP caching

**Risk:** medium. Wrong cache rule = stale dynamic responses or miss-rate spikes on static fragments.

### Cut 11: Admin preview for dynamic targets

**Files modified:**
- `packages/gazetta/src/admin-api/routes/preview.ts` — when previewing a page on a `dynamic` target, run the origin handler in-process (dev mode); pass admin-provided `RenderContext` (preview's `?preview=draft` etc.)
- `apps/admin/src/client/components/PreviewPanel.vue` — pass dynamic-target context (params, query) via URL; preview iframe URL builds the right shape

**Tests:**
- Preview a page with dynamic fragment → origin invoked in-process → composed HTML returned
- Preview with route params (`/blog/:slug`) → admin lets author specify slug; origin receives `ctx.params.slug`

**Risk:** medium. Preview parity is critical for author trust ("WYSIWYG"); divergence between preview and published causes regression-hunting friction.

### Cut 12: Sitemap + hreflang for dynamic routes

**Files modified:**
- `packages/gazetta/src/sitemap.ts` — include dynamic-route pages enumerated from `routes.json`
- Hreflang for dynamic routes: cross-domain targets via sitemap (per design-i18n.md), HTML head injection for subpath targets

**Tests:**
- Sitemap includes static + static-with-params + dynamic routes
- Hreflang correctness across all three modes

**Risk:** low. Sitemap is well-understood; cut adds one more enumeration source.

### Cut 13: Per-platform deployment validation

**What ships:** integration tests (or smoke tests in CI) that validate end-to-end dynamic-target deployment on a real platform.

**Files added:**
- `tests/e2e/rendering-dynamic-cloudflare.spec.ts` (skipped in CI by default; runs on `RENDERING_E2E=cloudflare` env) — deploys a fixture site to Cloudflare Workers + Fly.io origin, asserts page composition works
- `tests/e2e/rendering-dynamic-single-process.spec.ts` — `gazetta serve` dual-role; same fixture; smaller test envelope (runs in CI by default)

**Tests:**
- Single-process: dynamic fragment renders fresh content per request
- Split-deployment: worker calls origin; origin returns rendered fragment; page composes

**Risk:** medium. End-to-end validates the integrated system; bugs at any earlier cut surface here.

### Cut 14: Docs

**Files added/modified:**
- `docs/rendering.md` (NEW) — operator guide: target type choice; deployment topology; per-fragment timeout/failure; programmatic listings example
- `docs/cloudflare.md` — extend with per-target-type sections per design's "Operator documentation responsibility"
- `docs/self-hosted.md` — same for `gazetta serve` dual-role
- `examples/starter` — add a dynamic fragment example (e.g., a "live trending" widget)
- `ROADMAP.md` — mark Tier 3 implementation complete
- `CLAUDE.md` — link `docs/rendering.md`

## Validation gate (definition of done)

- [ ] All 14 cuts merged
- [ ] Provisional locks resolved before cuts 5, 6, 9 ship
- [ ] Static target works on Cloudflare Pages (no-Worker) + GitHub Pages
- [ ] ESI target works on Cloudflare Workers + `gazetta serve`
- [ ] Dynamic target works split (Cloudflare Workers + Fly.io origin) + single-process (`gazetta serve`)
- [ ] Listings (`pages.where(...).list()`) work at publish time + request time
- [ ] Route conflict detection blocks invalid configurations at publish
- [ ] Per-fragment failure modes work end-to-end with audit integration
- [ ] Admin preview matches published rendering for all three target types

## Deferred items

| Item | Trigger to revisit |
|---|---|
| WinterTC edge as origin (`runtime: 'edge'`) | WASM-compiled templates OR framework support catches up |
| Cursor pagination for listings | Offset-based pagination becomes the bottleneck at scale |
| Plugin-registered routes (e.g., search plugin adds `/api/search`) | Concrete plugin demand; covered by `design-plugins.md` future |
| Per-component cache hints (component-level cache headers) | Operator demand for finer cache tuning |
| Validator coherence for cache-coherent dynamic outputs | Cache-correctness validators when validation Cut 3 ships |
| Worker hot-reload of new dynamic routes | Operator demand; today: redeploy required |
| Free-text search via listings | Out of scope per `docs/non-goals.md` (delegated to Algolia/Meilisearch) |
| Render-time queries with side effects (writes from templates) | Strategic non-fit (templates are pure functions per `operations.md`) |

## Open implementation questions

1. **`RenderContext` field shape** — provisional. Recommended `{ params, query, headers, cookies, principal, locale, theme, target, requestId, now }`. Lock via 1-day grilling pass before cut 2.
2. **Fragment `rendering` field: explicit vs. inferred** — recommend explicit + validator. Confirm before cut 5.
3. **Worker → origin protocol shape** — HTTP-based per-fragment fetch is the recommendation. Final shape locked before cut 9 (~2 days grilling).
4. **Cache key for dynamic responses with route params** — origin sets `Cache-Control` headers; worker honors. Final shape locked before cut 10.
5. **`gazetta serve` dual-role vs. separate `gazetta origin`** — recommend dual-role (matches single-process self-hosted operator UX). Lock at cut 8.

## Estimates

Wall-clock for solo dev. Provisional locks take ~3 days total (cuts 2, 5, 6, 9 each gated on small grilling passes).

| Cut | Estimate |
|---|---|
| 1 (Target type enum) | 0.5 day |
| 2 (RenderContext) | 1 day + grilling |
| 3 (Listings API) | 3 days |
| 4 (Listings cache) | 1 day |
| 5 (Fragment rendering field) | 1.5 days + grilling |
| 6 (Route discovery) | 3 days + grilling |
| 7 (Timeout + onFailure) | 1.5 days |
| 8 (Dynamic origin runtime) | 4 days |
| 9 (Worker → origin protocol) | 4 days + grilling |
| 10 (Worker cache rule) | 1 day |
| 11 (Admin preview) | 2 days |
| 12 (Sitemap + hreflang) | 1 day |
| 13 (Per-platform validation) | 3 days |
| 14 (Docs) | 2 days |

**Total: ~28 days + ~3 days grilling.** Budget ~6-8 weeks with iteration on cuts 8-13 (the new runtime + cross-process protocol + integration testing).

## SOLID checks per cut

- **Cut 1**: ISP — `type` enum is a single field; behavior in dedicated runtime modules (`runtime/static.ts`, `runtime/esi.ts`, `runtime/dynamic.ts`).
- **Cut 2**: ISP — `RenderContext` shape is locked; immutable; doesn't grow per consumer needs without a design-pass amendment.
- **Cut 3**: SRP — `PageQuery` builder is one concern; filter implementation is a peer module. DIP — templates depend on the `PageQuery` interface; storage walker is the implementation.
- **Cut 4**: DIP — listings depend on `AdminCache` interface; multi-instance providers slot in without consumer changes.
- **Cut 5**: OCP — adding a new rendering type (e.g., a future 'partial-hydration' mode) extends the enum and adds a runtime module; existing modes unchanged.
- **Cut 6**: SRP — route discovery, route-conflict detection, routes.json emission are three concerns in three files.
- **Cut 7**: SRP — fragment-failure handling is its own module; doesn't bleed into rendering or worker logic.
- **Cut 8**: SRP — origin handler is one concern; one entry point per request.
- **Cut 9**: SRP — worker-side origin client and origin-side request handler are two distinct concerns; encoding/decoding is a shared utility.
- **Cut 10**: ISP — worker cache rule is a pure function over response headers + URL; doesn't grow knowledge of fragment internals.
