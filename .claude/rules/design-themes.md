---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/types.ts"
  - "apps/admin/src/client/stores/theme.ts"
  - "apps/admin/src/client/assets/tokens.css"
  - "**/theme*"
---

# Themes — design pass pending

Foundational dimension #3 of 8. Extends the asset-side theme dimension to pages/fragments/templates as a first-class render-context dimension.

**Status**: design pass pending — sequenced 4 of 8 (after `design-i18n.md`). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Theme check** every new feature design must answer
- [`design-media.md`](design-media.md) — locked theme invariants on the asset side
- [`css-theming.md`](css-theming.md) — admin UI theming via PrimeVue tokens
- [`design-i18n.md`](design-i18n.md) — sibling foundational dimension; locale + theme compose

## Why this is foundational

Themes is half-shipped: assets have full per-theme variant support; admin uses theme tokens via PrimeVue; pages and fragments do NOT have theme variants. Without a uniform contract, every new feature shipped between now and the design pass either ignores theme or guesses how it should behave. Retrofit risk.

## Locked invariants (already decided in `design-media.md`)

These extend uniformly to pages/fragments when the design pass formalizes:

- **Closed dimension set: locale + theme.** No third dimension without extending `DIMENSION_ORDER` (`packages/gazetta/src/schema/dimensions.ts`).
- **Locale-priority cross-dimension fallback** — `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. Locked, non-configurable. Locale matters more than visual presentation when content has to fall back.
- **Filename composition order: locale before theme.** `{name}.asset[.{loc}][.{theme}].json`. Adding a future dimension extends the order; existing filenames stay valid (no value for the new dimension).
- **Theme name validation** — lowercase ASCII, must NOT collide with valid BCP 47 locale codes (so `hero.asset.en.json` is unambiguously a locale variant, never a theme variant).
- **Site config opt-in** — `themes.supported: [light, dark]` in `site.yaml` enables the dimension. When absent, the theme dimension is unused.

## Open questions for the design pass

### Render-context shape
- How does theme reach a template? `params.theme` argument like `params.locale`? Render-context object?
- How does the runtime decide the theme? `prefers-color-scheme` cookie? URL parameter? Class-based cascade only (current css-theming.md approach)?
- For dynamic targets, is theme part of the request-context (cookie/header lookup at request time)?

### Pages and fragments with theme variants
- Filename scheme — `page.fr.dark.json`? Or just metadata declaration in the manifest?
- Are theme variants partial overlays (like locale variants can be) or whole-file?
- How do components with theme-variant assets render under different active themes — re-resolve assets at render time?

### Templates
- Should templates declare which themes they support? Or assume all configured themes work?
- Theme-aware CSS today is class-based (`.dark .foo`); does that stay, or do templates take theme as a param?
- Can a template author opt OUT of theme variation (e.g., a logo that's the same in all themes)?

### Admin UX
- Active theme switcher — does the admin show a per-page theme preview? A site-wide active-theme selector?
- Editing in theme A while theme B has different content — locale-style editing pattern?

### Composition with locale
- The asset model already locks `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. The design pass confirms this propagates uniformly to pages/fragments.

## Migration

Sites without `themes.supported` continue to work — theme dimension is unused. Adding `themes:` enables the feature; existing pages/fragments become "default theme" automatically.

## Future directions

- Theme marketplace — npm? Curated registry? Out of scope for v1.
- Independent theme versioning — out of scope for v1.
- Admin chrome theming via Theme entity — out of scope; admin theming stays in `css-theming.md`'s scope.
