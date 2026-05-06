---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/types.ts"
  - "packages/gazetta/src/admin-api/routes/preview.ts"
  - "apps/admin/src/client/stores/theme.ts"
---

# Themes — Implementation

Companion to [design-themes.md](design-themes.md). Cut sequence with risk ordering.

See [design-themes.md](design-themes.md) for the design itself.

## Status

Asset-side theme variants already shipped per [`design-media-implementation.md`](design-media-implementation.md). Admin theme switcher (UI chrome only) shipped per [`css-theming.md`](css-theming.md). What's missing: page/fragment **render-context** for theme — `params.theme` plumbed through the renderer + a request-time resolution chain on dynamic targets.

This is a small, focused implementation pass. The architectural seams already exist (asset resolver accepts `theme` in its context per `design-media.md`'s "v1 scope of theme" note); the cuts wire them through.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `themes-render-context` off `main`. **No backwards compatibility** — sites without `themes.supported` configured continue to work because `params.theme` defaults to the configured default (or `null` when the dimension is unused).

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `SiteConfig.themes` schema (Zod): `{ supported: string[], default: string }` + theme-name validator (lowercase ASCII, not BCP-47-locale-shaped) | ☐ | Low | Config contract |
| 2 | `RenderContext.theme: string \| null` + render-context plumbing through renderer | ☐ | Medium | Render-time parameter shape |
| 3 | Resolution chain on dynamic + ESI targets (`?theme=` > cookie > `prefers-color-scheme` > `themes.default`) | ☐ | Medium | Request-time resolution |
| 4 | Asset resolver consumes `RenderContext.theme` (already accepted; wire from real call sites) | ☐ | Low | Theme-variant asset selection on real renders |
| 5 | Admin preview endpoint forwards admin's active theme via `?theme=` | ☐ | Low | Preview parity with rendered targets |
| 6 | `AdminCache` keys include theme dimension where output differs per theme | ☐ | Low | Cache correctness |
| 7 | Static publish picks single-theme-per-target (configurable) — ships single-theme variant; flag-gated future multi-theme publish | ☐ | Medium | Static target shape |
| 8 | Docs (`docs/themes.md` operator + template-author guide) + example template using `params.theme` | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: `themes` config schema

**Files modified:**
- `packages/gazetta/src/config/schemas.ts` — add `themesSchema = z.object({ supported: z.array(z.string()).min(1), default: z.string() })` with refinement: each name lowercase ASCII; not matching BCP-47 locale shape (`isValidLocale(name) === false`); `default` must be in `supported`
- `packages/gazetta/src/types.ts` — add `SiteManifest.themes?: { supported: string[]; default: string }`
- `packages/gazetta/src/site-loader.ts` — pass through unchanged (Zod validates at boot)

**Tests:**
- Theme name `'dark'` valid; `'en'` rejected (BCP-47 collision); `'Dark'` rejected (not lowercase); empty array rejected
- `default` outside `supported` rejected
- Sites without `themes` block load normally (manifest's `themes` is undefined)

**SOLID:** SRP — config schema is one concern; the validator is a pure function the runtime can also use to validate operator-supplied theme names from query params.

### Cut 2: `RenderContext.theme` plumbing

**Files modified:**
- `packages/gazetta/src/types.ts` — `RenderContext` already has `locale`; add `theme: string | null` (null = theme dimension unused on this site)
- `packages/gazetta/src/renderer.ts` — accept `theme` in render entry points; pass through to template invocations as `params.theme`
- All template signatures: existing `params: { content, children?, locale }` becomes `params: { content, children?, locale, theme }`

**Tests:**
- Renderer with `theme: 'dark'` → template's `params.theme === 'dark'`
- Renderer with `theme: null` → template's `params.theme === null` (sites without theme config)
- Existing tests pass (theme is additive at signature level)

**Risk:** medium. Template signature changes touch every test fixture template. The `null` default keeps existing tests passing without modification.

### Cut 3: Request-time resolution chain

**Files added:**
- `packages/gazetta/src/runtime/resolve-theme.ts` — `resolveTheme(req, site): string | null`
  - If site has no `themes` config → `null`
  - Else lookup chain: `req.query.theme` (validated against `supported`) > cookie `gazetta_theme` > `prefers-color-scheme` request header > `themes.default`
  - Invalid query/cookie value → falls through to next in chain (don't reject the request)

**Files modified:**
- `packages/gazetta/src/admin-api/routes/preview.ts` — call `resolveTheme(c.req, site)` to populate render context
- Worker runtime (`packages/gazetta/src/workers/cloudflare.ts` etc. when shipped) — same hook
- `gazetta serve` request handler — same hook

**Tests:**
- Each chain step in isolation: query > cookie > header > default
- Invalid query value falls through; doesn't error
- Site without `themes` returns null regardless of query
- Property test: chain is deterministic (same inputs → same theme)

**Risk:** medium. The chain order is the design pass's locked decision; deviation = wrong theme rendered. Test each step.

### Cut 4: Asset resolver consumes theme

**Files modified:**
- `packages/gazetta/src/renderer/resolve-asset.ts` — `AssetResolveContext` already accepts `theme` per `design-media.md`; verify call sites pass it through. Where `RenderContext.theme` is `null`, pass `undefined` to the resolver (asset resolver treats `undefined` as "no theme override").

**Tests:**
- Asset with `dark` variant + render context theme=`dark` → resolver picks dark bytes
- Same asset + theme=`null` → resolver picks default bytes
- Cross-dimension fallback (locale=`fr` + theme=`dark`, only `(fr, light)` exists) → `(fr, light)` per locked locale-priority chain

**Risk:** low. The resolver already supports this; cut just ensures the call sites flow `RenderContext.theme` through.

### Cut 5: Admin preview forwards theme

**Files modified:**
- `apps/admin/src/client/stores/theme.ts` — already exists; verify it exposes the active theme name
- `apps/admin/src/client/components/PreviewPanel.vue` — preview iframe URL appends `?theme={active}` from the store

**Tests:**
- Toggle theme in admin → preview iframe URL changes
- Preview reload picks up new theme (via existing SSE invalidation)

**Risk:** low. Existing pattern (locale already flows this way).

### Cut 6: Cache key includes theme

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — page-render cache keys append `:theme:{name}` when site has `themes` config
- Asset URL cache keys (the resolver's per-invocation Map) — already keyed by `(name, locale)`; extend to `(name, locale, theme)` per `design-media.md`'s locked context shape
- Render-for-analysis cache (validation Cut 3 when it ships) — key includes theme

**Tests:**
- `pages:detail:home:en:dark` and `pages:detail:home:en:light` are independent entries
- Save invalidation via `invalidatePrefix('pages:detail:home:')` clears all theme variants

**Risk:** low. Key conventions are established (`design-cache.md` Q1).

### Cut 7: Static publish single-theme

**Files modified:**
- `packages/gazetta/src/types.ts` — `TargetConfig.theme?: string` (when target has theme set, publish renders that theme variant; default = `themes.default`)
- `packages/gazetta/src/publish.ts` (or `publish-rendered.ts`) — when site has `themes` config, render with the target's configured theme; static targets store the rendered HTML at the standard path (no per-theme path multiplication in v1)
- Operator config: `targets.production-dark: { ..., theme: 'dark' }` opt-in

**Why single-theme per static target:** multi-theme static publish would multiply the target's storage and complicate the cache-purge story. Operators wanting both light + dark static deployments configure two targets. ESI / dynamic targets resolve per request and don't need this.

**Tests:**
- Target with `theme: 'dark'` publishes dark-rendered HTML
- Target without `theme` publishes `themes.default`-rendered HTML
- Site without `themes` config: target's `theme` field rejected at config-load (Zod refinement)

**Risk:** medium. Storage layout doesn't change in v1, but the renderer must use the right theme consistently across pages/fragments/assets in one publish run.

### Cut 8: Docs

**Files added/modified:**
- `docs/themes.md` (NEW) — operator config, template-author guide (how to use `params.theme`), resolution chain, single-theme-per-static-target trade-off
- `examples/starter/templates/hero/index.tsx` — example using `params.theme` to pick CSS class
- `examples/starter/sites/main/site.config.ts` — commented-out `themes: { supported: ['light', 'dark'], default: 'light' }` block
- `CLAUDE.md` — link `docs/themes.md`

## Validation gate (definition of done)

- [ ] All 8 cuts merged
- [ ] Manual test: site with `themes: { supported: ['light', 'dark'] }` configured; `?theme=dark` renders dark CSS + dark asset variants
- [ ] Manual test: cookie persists theme across page loads; `prefers-color-scheme` header respected when no cookie
- [ ] Validation: theme name colliding with BCP-47 locale rejected at config load
- [ ] Existing sites (no `themes` config) continue to work; `params.theme === null` in templates

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Multi-theme static publish (per-theme path multiplication on static targets) | Operator demand for both light + dark on a single static target |
| Theme-aware validator (e.g., "missing dark variant" warning) | Validation Cut 3 (render-for-analysis); concrete demand |
| Theme marketplace / curated registry | Strategic; not in v1 scope |
| Independent theme versioning | Strategic; not in v1 |
| Admin chrome theming via Theme entity (vs PrimeVue tokens) | `css-theming.md`'s scope; product matures past prototype |
| Per-role theme gating | Concrete demand from accessibility-context operators |
| Custom theme dimensions beyond presentation (audience, campaign, A/B, multi-tenant) | Each gets its own design pass when demand surfaces |

## Open implementation questions

1. **Cookie name + lifetime.** Proposed: `gazetta_theme`, 1-year `Max-Age`, `SameSite=Lax`. Lock at cut 3.
2. **`prefers-color-scheme` mapping.** Browsers send `prefers-color-scheme: dark` or `light`. If site supports those literal names, map directly. If site supports `'midnight'` instead of `'dark'`, the operator declares mapping in config. Defer the explicit mapping until a real operator config requires it; v1 maps `dark`/`light` literals only.
3. **Worker-target theme cookie storage.** On Cloudflare Workers, setting cookies requires a response-side `Set-Cookie`. The toggle endpoint that sets the cookie is admin-side; published targets just read what's already set. Confirm at cut 3.
4. **Theme name reserved words.** Do we forbid `default`? `auto`? `system`? Recommend: forbid `default` and `auto` (collisions with the resolution chain semantics); allow others. Lock at cut 1.

## Estimates

Wall-clock for solo dev:

| Cut | Estimate |
|---|---|
| 1 (Config schema) | 0.5 day |
| 2 (RenderContext.theme) | 1 day |
| 3 (Resolution chain) | 1 day |
| 4 (Asset resolver wiring) | 0.5 day |
| 5 (Preview forwards theme) | 0.5 day |
| 6 (Cache key) | 0.5 day |
| 7 (Static publish single-theme) | 1 day |
| 8 (Docs) | 0.5 day |

**Total: ~5.5 days.** Budget ~1 week with iteration on cut 7's static publish details.

## SOLID checks per cut

- **Cut 1**: SRP — schema validator, name validator, BCP-47-collision check are three distinct concerns; each gets its own pure function.
- **Cut 2**: ISP — `RenderContext.theme` is a single field, not a capability interface. OCP — adding `theme` doesn't change existing `RenderContext.locale` semantics.
- **Cut 3**: SRP — `resolveTheme` is one pure function; chain rules captured as data, not branches in callers. DIP — runtime modules depend on `resolveTheme`, not on its internal lookup logic.
- **Cut 4**: DIP — asset resolver already depends on `theme` abstractly (`AssetResolveContext.theme`); cut just connects real call sites.
- **Cut 6**: SRP — cache keys are encoded once via key utility; consumers don't construct them ad-hoc.
- **Cut 7**: OCP — `TargetConfig.theme` is additive; targets without it use `themes.default`. Existing target configs unchanged.
