---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/types.ts"
  - "apps/admin/src/client/stores/theme.ts"
  - "apps/admin/src/client/assets/tokens.css"
  - "**/theme*"
---

# Themes

Foundational dimension #3 of 13. Establishes presentation theming (light/dark, color schemes, accessibility variants) as a render-context dimension. Asset-level theme variants already shipped per `design-media.md`; this pass formalizes the page/fragment/template contract.

**Status**: design pass complete (2026-05). Implementation phases sit in Tier 3 — admin theme switcher already shipped per `css-theming.md`; runtime theme resolution + render-context parameter implementation lands when concrete operator demand surfaces.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Theme check** every new feature design must answer
- [`design-media.md`](design-media.md) — locked theme invariants on the asset side
- [`css-theming.md`](css-theming.md) — admin UI theming via PrimeVue tokens
- [`design-i18n.md`](design-i18n.md) — sibling foundational dimension; locale + theme compose

## Why this is foundational

Themes is half-shipped: assets have full per-theme variant support; admin uses theme tokens via PrimeVue; pages and fragments do NOT have theme variants. Without a uniform contract, every new feature shipped between now and the design pass either ignores theme or guesses how it should behave. Retrofit risk.

## Scope: presentation theming only

The "themes" dimension covers **presentation theming** — light/dark mode, color schemes, accessibility variants — decided at request time from cookie / `prefers-color-scheme` / URL.

**Out of scope** (each gets its own future design pass when demand materializes):

| Motivation | Future design |
|---|---|
| Brand-per-audience, white-label, multi-tenant | Per-target content (#62 — already in deferred backlog) |
| Seasonal / campaign theming | Time-bounded content (related to scheduled publishing #198) |
| A/B testing visual variants | Experiment infrastructure — not on roadmap; future Tier 3 |
| Per-tenant content forks | Multi-target architecture — already supported via separate Gazetta deployments |

**Why narrow scope**: the asset model's `design-media.md` locked `locale + theme` as the closed dimension set; pulling four other motivations into "themes" would conflate semantically different concepts (request-time vs. author-time, per-user vs. per-deployment). Each motivation has different lifecycles, different ownership, different infrastructure. Each gets its own design pass when concrete demand surfaces.

**The architectural seams stay reserved** for those future passes:

- `DIMENSION_ORDER` in `packages/gazetta/src/schema/dimensions.ts` is documented as an extension point — adding a new dimension requires a design pass; not a default extension.
- Render-context object is already extensible; future `params.audience`, `params.campaign`, `params.experiment` are forward-additive when dimensions ship.
- `Site` type already separates `pages`/`fragments`/`assets`; future per-audience or per-campaign content tree slots in as new top-level entries.
- `StorageProvider` is provider-agnostic; per-tenant deployments share the abstraction.

This pass commits to theme-as-presentation only. Other dimensions are designed when needed; the closed-set commitment doesn't pre-commit them.

## Locked invariants

**Asset-side (already locked in `design-media.md`):**

- **Closed dimension set: locale + theme.** No third dimension without extending `DIMENSION_ORDER` (`packages/gazetta/src/schema/dimensions.ts`).
- **Locale-priority cross-dimension fallback** — `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. Locked, non-configurable. Locale matters more than visual presentation when content has to fall back.
- **Filename composition order: locale before theme.** `{name}.asset[.{loc}][.{theme}].json`. Adding a future dimension extends the order; existing filenames stay valid (no value for the new dimension).
- **Theme name validation** — lowercase ASCII, must NOT collide with valid BCP 47 locale codes (so `hero.asset.en.json` is unambiguously a locale variant, never a theme variant).
- **Site config opt-in** — `themes.supported: [light, dark]` in `site.yaml` enables the dimension. When absent, the theme dimension is unused.

**Pages/fragments (this design pass commits):**

- **No data-layer theme variants for pages/fragments.** Theme is a render-context dimension, not a content-overlay dimension at the page/fragment level. There are no `page.dark.json` files; no `themes: {}` metadata blocks in page/fragment manifests.
- **Theme reaches templates as a render-context parameter** — `params.theme` peer to `params.locale`. Templates emit theme-aware CSS via cascade, pick theme-variant assets via the resolver, or branch on the parameter when render-time differences are needed.
- **Asset variants handle theme-specific imagery** — already shipped per `design-media.md`. A page with `<img>` from a theme-variant asset shows different bytes per active theme. The page manifest stays theme-agnostic; the asset reference resolves per theme.
- **CSS cascade handles theme-specific styles** — already shipped per `css-theming.md`. Templates emit `.dark .foo` or use `prefers-color-scheme` selectors. The theme parameter just lets templates know which theme is active for runtime decisions (e.g., picking a theme-variant asset reference).

## Open questions for the design pass

### Render-context shape
- Theme reaches templates via `params.theme` peer to `params.locale`. Confirmed direction.
- Open: shape of the parameter. String (`"dark"`)? Enum constrained to configured themes? Object with metadata (`{ name: 'dark', tokens: {...} }`)? Recommend: string matching a configured theme name — minimal, extensible.
- Open: how templates declare theme support. Should templates list `supportedThemes: ['light', 'dark']` in their manifest? Or assume any configured theme works? Recommend: assume any configured theme works (the simpler default); add explicit declaration only if a real conflict surfaces.

### Runtime theme resolution
- For static targets (pre-rendered): theme is decided at publish time per published variant, OR static targets choose a single theme per publish. Recommend: single theme per publish target — adding multi-theme static publish is a future capability if demanded.
- For dynamic / ESI targets: theme is decided at request time. Sources of truth: `?theme=` URL param > `theme` cookie (set by client-side toggle) > `prefers-color-scheme` header > `themes.default` site config. Recommend: this lookup chain.
- For preview: admin sends the active theme via `?theme=` to preview endpoint. Already partially shipped (per the css-theming admin pattern).

### Admin UX
- **Theme switcher in admin chrome** — already shipped per `css-theming.md`. Author toggles between themes; preview iframe respects the active theme.
- **Editing under different themes** — pages/fragments don't have theme variants at the content layer (locked invariant), so editing IS theme-agnostic. Admin doesn't show a "this content for dark theme" mode; theme switching only changes preview rendering.
- **Asset-level theme switching in admin** — when editing a page, the active theme affects which asset variant the preview shows. Asset library shows per-theme variant indicators per `design-media.md`. Already shipped on the asset side.

### Composition with each foundational dimension

- **Multi-instance check** (discipline) — theme resolution is stateless: manifests + assets live in storage; resolver reads per-request. No cross-instance coordination. Theme-preview state in admin is per-browser. Server-side `AdminCache` entries are keyed by theme (when caching theme-affected output); per-instance scope is sufficient.
- **Scale check** — at the operating envelope (5000 pages × 2 themes), no scaling concern at the page/fragment level (pages are theme-agnostic). Asset-level theme variants multiply file count per theme, but cross-dimension fallback means most assets need only the default-theme variant. Cache keys include theme; invalidation per-(content, theme) tuple.
- **Locale check** — locale is the peer dimension. Cross-dimension fallback per the locked invariant: locale-priority. Templates receive both `params.locale` AND `params.theme`; render context carries them as orthogonal axes.
- **Team check** — theme is per-user-preference; no role-based theme gating in v1. Audit log records the theme on writes (informational; useful for debugging "why did the published-prod asset look different on Tuesday").
- **Hook check** — hooks fire with `params.theme` available. A hook on save/publish can branch on theme if needed (rare); usually hooks are theme-agnostic.
- **Render check** — render context carries theme; render-for-analysis (validation Cut 3) caches per-(content, locale, theme) tuple. All four rendering modes (static, ESI, request-SSR, island) carry theme through their respective contexts.
- **Validation check** — theme-aware validators are an open design (e.g., a "missing-dark-variant" validator that flags assets without a theme variant when themes are configured). Deferred to validation Cut 3 alongside the locale-aware validators.
- **Plugin check** — plugin-supplied storage providers, AI providers, etc. see theme via existing context. Plugin-contributed validators that care about theme branch on the same parameter.
- **Cache check** — `AdminCache` keys include theme where the cached output differs per-theme (rendered HTML, resolved assets). Theme switch invalidates only theme-keyed entries; other entries (page summaries, dependents) stay fresh.
- **Offline check** — browser-side cache scopes entries by active theme. Offline theme switching reads from cached entries for the new theme; if not cached, surfaces the staleness banner. Save attempts during offline include the active theme in the queued payload.

## Migration

Sites without `themes.supported` continue to work — theme dimension is unused. Adding `themes:` enables the feature; existing pages/fragments become "default theme" automatically.

## Future directions

- Theme marketplace — npm? Curated registry? Out of scope for v1.
- Independent theme versioning — out of scope for v1.
- Admin chrome theming via Theme entity — out of scope; admin theming stays in `css-theming.md`'s scope.
