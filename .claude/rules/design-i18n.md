---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/types.ts"
  - "packages/gazetta/src/publish-rendered.ts"
  - "packages/gazetta/src/sitemap.ts"
  - "packages/gazetta/src/seo.ts"
  - "packages/gazetta/src/manifest.ts"
  - "apps/admin/src/client/stores/selection.ts"
  - "apps/admin/src/client/components/ComponentTree.vue"
  - "apps/admin/src/client/components/SiteTree.vue"
  - "**/i18n*"
  - "**/locale*"
---

# i18n / Locale

File-suffix localization: `page.json` (default locale), `page.fr.json` (French),
`page.en-gb.json` (British English). Same pattern for fragments: `fragment.fr.json`.
Zero template changes, zero schema changes. Opt-in via `locales` in site.config.ts.

**Foundational dimension #2 of 13.** Locale is a closed dimension peer to theme; every feature must respect locale variants, the locked locale-priority cross-dimension fallback, and the file-suffix model. See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions" — every new feature design answers the **Locale check**.

**Status**: design pass complete (2026-05). Implementation 13 of 15 steps shipped (whole-file locale variants, file-suffix model, fallback chain, hreflang, sitemap, admin locale picker, CLI translate, language detection — all live). Two implementation steps remaining: admin "Translate to..." action (step 12, surfaces in editor papercut cluster) and `gazetta validate` locale-file checks (step 15, lands with validation Cut 5 CLI rewrite). See "Implementation sequence" for per-step status.

**Migration note**: This doc was previously `i18n-plan.md` (predates the `design-{feature}.md` convention). Renamed in 2026-05 alongside the foundational-dimensions inventory. Per-field translation (#192) lands as the implementation phase under this design's contract; that's when the design/implementation split documented in [`feature-design-process.md`](feature-design-process.md) gets applied to this doc.

**Locked invariants** (referenced by other docs and the foundational-dimensions table):

- **Closed dimension set: locale + theme** — no third dimension without extending `DIMENSION_ORDER`
- **Locale-priority cross-dimension fallback** — `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. Locale matters more than visual presentation when content has to fall back.
- **File-suffix model** — `page.json` is the default locale; `page.fr.json` is French; etc. Each file is a complete manifest. Whole-file overlay.
- **Per-field overlay model (asset-side, future for pages/fragments)** — assets support layered per-locale overrides (metadata-only or with locale-specific bytes). Pages/fragments today are whole-file only; per-field overlays are #192's design space.
- **Subpath routing default** — `/about` (default locale, no prefix), `/fr/about` (French). Per-domain and hybrid strategies also supported.
- **hreflang strategy** — HTML `<head>` for subpath targets; sitemap-only for cross-domain targets (avoids timing 404s when one domain publishes before another).

**Status legend:** ☐ todo · ◐ in progress · ✓ done

---

## Design principles

1. **File suffix, not folders.** Translations live next to the page they translate —
   `page.json` and `page.fr.json` in the same directory. Co-location IS the link.
   No translation keys, no junction tables, no ID linking.

2. **Each locale file is a complete manifest.** French `page.fr.json` is a standalone
   page with its own template, components, content, metadata, and route. Locales can
   have different structure, different fragments, different component ordering.

3. **Templates are locale-agnostic.** Templates receive `content.title` (a string),
   not `content.title.fr` (a locale map). If a template needs "Read more" text, it's
   a content field — not hardcoded. The template contract is unchanged.

4. **Fallback chain.** `pt-BR` → `pt` → default locale. Configurable per locale in
   site.config.ts. Applies to both pages and fragments.

5. **Opt-in.** No `locales` in site.config.ts = no i18n. Existing sites work unchanged.
   `page.json` is the only manifest. Adding `locales` enables the feature —
   existing `page.json` files become the default locale automatically.

6. **Subpath routing.** `/about` (default locale, no prefix), `/fr/about` (French).
   Google's recommended approach. Default locale prefix is configurable.

---

## Configuration

```ts
// site.config.ts
import { defineSite } from 'gazetta'

export default defineSite({
  name: 'My Site',
  locales: {                      // new (optional) — enables i18n
    default: 'en',                // optional — default locale (falls back to first in supported)
    supported: ['en', 'fr', 'de', 'pt-BR'],
    fallbacks: {                  // optional — locale-specific fallback chains
      'pt-BR': 'pt',              // pt-BR falls back to pt before default
    },
  },
})
```

`locales.default` is optional. When omitted, the first entry in `locales.supported`
is the default. `locales: { default: 'en', supported: ['en', 'fr'] }` and
`locales: { supported: ['en', 'fr'] }` are equivalent.

When `locales` is absent, the site is single-locale (defaults to `en`) for
`<html lang>` and sitemap, same as today. Adding `locales.supported` is the
only change needed to enable i18n — everything else has sensible defaults.

### Defaults

#### Site-level defaults

| Setting | Default | Why |
|---------|---------|-----|
| `locales.default` | First in `supported` list | `supported: [en, fr]` → default is `en` |
| `detection` | `false` | Opt-in — don't redirect until the author is ready |
| `defaultPrefix` | `false` | Google recommended — `/about` not `/en/about` |
| `fallbacks` | None — fall through to default locale | Explicit chains are rare |

#### Target-level defaults

Every target setting inherits from the site level unless overridden.

| Setting | Default | Why |
|---------|---------|-----|
| `locales` | Site's `supported` | Serve all locales unless narrowed |
| `locale` | Site's `locales.default` | Same default locale unless overridden |
| `detection` | Site's `detection` | Consistent unless overridden |
| `defaultPrefix` | Site's `defaultPrefix` | Consistent unless overridden |

#### Single-locale target inference

A target with `locales: [fr]` (one entry) automatically infers:
- `locale: fr` — the only locale IS the default
- `defaultPrefix: false` — no prefix needed
- `detection: false` — nothing to detect

No explicit config needed — the system infers from the single-entry list.

#### Minimal i18n setup

```ts
// Minimum config to enable i18n — everything else is inferred
export default defineSite({
  locales: {
    default: 'en',
    supported: ['en', 'fr'],
  },
})
```

This gives:
- `page.json` = English (default), `page.fr.json` = French
- Routes: `/about` (en), `/fr/about` (fr)
- hreflang in `<head>` and sitemap
- All targets serve both locales
- No language detection redirect
- No prefix for default locale

### Deployment strategies

Three strategies for serving localized content. Same content files, different
target configurations. All can coexist in the same site.

#### Strategy 1: Subpath — one target, all locales in URL

```ts
export default defineSite({
  targets: {
    local: {
      storage: filesystemStorage(),
      // inherits all site-level locales, default = en
    },

    production: {
      storage: s3Storage({ bucket: 'site' }),
      environment: 'production',
      siteUrl: 'https://example.com',
      // → /about (en), /fr/about, /de/about, /pt-br/about
    },
  },
})
```

Default locale has no prefix. Other locales get `/{locale}/` prefix.
Google's recommended approach — inherits domain authority.

#### Strategy 2: Per-domain — one target per locale

```ts
export default defineSite({
  targets: {
    local: {
      storage: filesystemStorage(),
      // dev serves all locales with subpath (convenient for development)
    },

    'production-en': {
      storage: s3Storage({ bucket: 'site-en' }),
      environment: 'production',
      siteUrl: 'https://example.com',
      locales: ['en'],            // single locale — no prefix, no hreflang on this domain
      // → /about (en only)
    },

    'production-fr': {
      storage: s3Storage({ bucket: 'site-fr' }),
      environment: 'production',
      siteUrl: 'https://example.fr',
      locales: ['fr'],            // single locale
      // → /about (fr only)
    },

    'production-de': {
      storage: s3Storage({ bucket: 'site-de' }),
      environment: 'production',
      siteUrl: 'https://example.de',
      locales: ['de', 'en'],      // two locales — German default, English secondary
      locale: 'de',               // overrides default for this target
      // → /about (de), /en/about (en)
    },
  },
})
```

Each target serves one domain with its own locale subset. hreflang
cross-links point across domains using each target's `siteUrl`.

#### Strategy 3: Hybrid — subpath for dev, per-domain for production

```ts
export default defineSite({
  targets: {
    local: {
      storage: filesystemStorage(),
      // all locales via subpath — author previews everything locally
    },

    'production-en': {
      storage: s3Storage({ bucket: 'site-en' }),
      environment: 'production',
      siteUrl: 'https://example.com',
      locales: ['en'],
    },

    'production-fr': {
      storage: s3Storage({ bucket: 'site-fr' }),
      environment: 'production',
      siteUrl: 'https://example.fr',
      locales: ['fr'],
    },
  },
})
```

Author works in subpath mode locally (one server, all locales). Publishes
to separate per-domain production targets. Same content files, different
URL structure per target.

### Language detection and redirect

The Hono runtime detects the visitor's preferred language from the
`Accept-Language` header and redirects to the matching locale subpath.

```
GET /about
Accept-Language: fr-FR,fr;q=0.9,en;q=0.8

→ 302 Location: /fr/about
```

Behavior:
- Only redirects when the request path has no locale prefix (i.e., hits
  the default locale route)
- Checks Accept-Language against the target's supported locales
- Redirects to the best match, or serves the default locale if no match
- Uses 302 (temporary) — not 301, so Google crawls the default URL
- Cookie opt-out: after the user explicitly switches locale, a `locale`
  cookie overrides Accept-Language on subsequent visits
- Configurable at site level (default for all targets) and per target
  (override). Target config wins.

```ts
// site.config.ts
export default defineSite({
  locales: {
    supported: ['en', 'fr', 'de'],
    detection: true,             // site-level default — all targets redirect
    defaultPrefix: false,        // site-level default — no prefix for default locale
  },

  targets: {
    local: {
      storage: filesystemStorage(),
      // inherits site-level detection: true
    },

    production: {
      siteUrl: 'https://example.com',
      detection: false,          // override — no redirect on production (CDN handles it)
      defaultPrefix: true,       // override — all locales prefixed: /en/about, /fr/about
    },

    staging: {
      siteUrl: 'https://staging.example.com',
      // inherits site-level detection: true, defaultPrefix: false
    },
  },
})
```

This is a runtime feature — only applies to `gazetta serve` and edge
workers. `gazetta dev` supports it for testing. Static file hosting
(no runtime) cannot do this — users land on the default locale and
navigate manually.

### Target locale rules

- Target inherits site-level `locales.supported` and `locale` (default) unless
  it declares its own.
- `locales: [de, en]` on a target restricts which locales are published/served.
  Pages without a matching locale file are skipped for that target.
- `locale: de` on a target overrides the default locale for that target. The
  default locale has no URL prefix; other locales get prefixed.
- A target with a single locale (e.g., `locales: [fr]`) is single-language —
  no URL prefix, no locale switching. hreflang still generated if other targets
  serve the same pages in different locales (cross-domain hreflang).
- No locale config on a target → inherits all site-level locales.

### hreflang strategy: HTML for subpath, sitemap for cross-domain

Two different hreflang mechanisms depending on deployment strategy.
This avoids the timing problem (publishing one domain before another
creates hreflang pointing to 404s — Google ignores the entire cluster).

#### Subpath targets (one domain, all locales)

hreflang in HTML `<head>`, injected at render time. No timing issues —
all locales are published to the same target in one pass.

```html
<!-- On example.com/about (en, subpath target) -->
<link rel="alternate" hreflang="en" href="https://example.com/about" />
<link rel="alternate" hreflang="fr" href="https://example.com/fr/about" />
<link rel="alternate" hreflang="x-default" href="https://example.com/about" />
```

Self-referencing required (Google ignores the cluster without it).
Only includes locales that have content (discovered from sibling
`page.*.json` files).

#### Per-domain targets (separate domains per locale)

hreflang in **sitemap only** — NOT in HTML `<head>`. Generated as a
post-publish step after all targets are published.

```xml
<!-- sitemap.xml on example.com -->
<url>
  <loc>https://example.com/about</loc>
  <xhtml:link rel="alternate" hreflang="en" href="https://example.com/about"/>
  <xhtml:link rel="alternate" hreflang="fr" href="https://example.fr/about"/>
  <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about"/>
</url>
```

Each target's sitemap includes cross-domain links to all other targets.
Bidirectionality enforced — `example.com` sitemap links to `example.fr`
AND `example.fr` sitemap links back to `example.com`.

**Why sitemap, not HTML:**
- Publishing `prod-en` before `prod-fr` would create HTML hreflang
  pointing to pages that don't exist yet (404). Google ignores the
  entire hreflang cluster when this happens.
- Sitemaps are regenerated AFTER all targets are published. Only pages
  that return 200 on all targets get cross-domain hreflang.
- Google processes sitemap hreflang the same as HTML hreflang.

**Post-publish sitemap generation:**
1. Publish all locale targets (existing sequential pipeline)
2. After all targets are done, scan all targets' sidecars
3. Group pages by directory (same page, different locales/targets)
4. Generate per-target sitemaps with cross-domain hreflang
5. Upload sitemaps to each target's storage

If a page exists on `prod-en` but not yet on `prod-fr`, the sitemap
omits the cross-domain hreflang for that page. When `prod-fr` is
published later, the sitemap is regenerated with the new link.

**Validation:** `gazetta validate` checks that all cross-domain
hreflang pairs are bidirectional and that target URLs return 200.

#### Mixed strategy

A site can use both:
- `production-global` (subpath, one domain, all locales): HTML hreflang
- `production-de` (per-domain, single locale): sitemap hreflang

The publisher detects the strategy from target config:
- Target with 2+ locales → subpath → HTML hreflang at render time
- Target with 1 locale + other targets serving same pages → cross-domain → sitemap hreflang post-publish

---

## File structure

```
pages/about/
  page.json          ← default locale (en)
  page.fr.json       ← French
  page.de.json       ← German
  page.pt-br.json    ← Brazilian Portuguese (lowercase in filename)
  hero/              ← inline components (shared across locales via manifest)

fragments/header/
  fragment.json      ← default locale
  fragment.fr.json   ← French header
  logo/
  nav/
```

**Naming convention:** Locale codes lowercase in filenames: `page.fr.json`,
`page.en-gb.json`. The parser normalizes before lookup. BCP 47 codes are
case-insensitive but file systems may not be.

**Rule:** `page.json` is the default locale. `page.en.json` is NOT allowed when
`en` is the default — it would be ambiguous. `gazetta validate` catches this.

---

## Route generation

| File | Route |
|------|-------|
| `pages/about/page.json` | `/about` |
| `pages/about/page.fr.json` | `/fr/about` |
| `pages/about/page.de.json` | `/de/about` |
| `pages/about/page.pt-br.json` | `/pt-br/about` |

Default locale has no prefix (configurable via `defaultPrefix: true`).

Dynamic routes: `pages/blog/[slug]/page.json` → `/blog/:slug`,
`page.fr.json` → `/fr/blog/:slug`. Same slug across locales (simplest).
Locale-specific slugs are a future enhancement (via `slug` field in manifest).

---

## Fragment locale resolution

When the renderer resolves `@header` for a French page:

1. Look for `fragment.fr.json` in `fragments/header/`
2. If not found, check fallback chain: `fragment.pt.json` for `pt-BR`
3. If no fallback, use `fragment.json` (default locale)

This applies at both render time (dev server, publish) and request time
(edge composition for static targets).

### Static targets (pre-rendered)

Publishing `@header` produces one rendered HTML per locale. Locale
suffix in filename matches the content file pattern:

```
fragments/header/           (target storage)
  index.html                ← default locale
  index.fr.html             ← French
  index.de.html             ← German
  styles.a1b2c3d4.css       ← shared (or per-locale if CSS differs)
  script.e5f6g7h8.js        ← shared
```

**ESI placeholders** carry the locale:
```html
<!-- Page rendered for French locale -->
<!--esi:/fragments/header/index.fr.html-->
```

The edge runtime extracts the locale from the URL prefix, then
fetches the locale-suffixed fragment file. Fallback: if
`index.fr.html` doesn't exist, fetch `index.html` (default).

**Sidecars** carry the locale in the filename:
```
.cf120e4b.hash              ← default locale hash
.cf120e4b.hash.fr           ← French locale hash (different content → different hash)
.uses-header                ← same across locales (structural)
.tpl-header-layout          ← same across locales (structural)
.pub-20260419T100000Z       ← default locale publish timestamp
.pub-20260419T100000Z.fr    ← French publish timestamp
```

Each locale variant has its own hash and publish timestamp. The
compare pipeline diffs per-locale — only changed locale variants
are re-rendered on incremental publish.

### Dynamic targets (SSR)

The runtime SSRs the fragment using the locale-specific manifest
(`fragment.fr.json`), falling back through the chain. No pre-rendered
files — the manifest is loaded per request.

---

## SEO: hreflang

See "hreflang strategy" section above for the full design.

**Summary:** HTML `<head>` hreflang for subpath targets (same domain, all
locales). Sitemap-only hreflang for cross-domain targets (avoids timing/404
problems). Mixed strategy supported.

**Rules for both mechanisms:**
- Self-referencing required (Google ignores the cluster without it)
- Only includes locales that have content (discovered from sibling files)
- Locale variants with `metadata.robots: "noindex"` excluded
- `x-default` points to the default locale
- Bidirectionality enforced — validated by `gazetta validate`

---

## Sitemap

One `sitemap.xml` per target containing all locales. Each locale URL gets
its own `<url>` entry with bidirectional hreflang cross-links:

```xml
<url>
  <loc>https://example.com/about</loc>
  <lastmod>2026-04-18</lastmod>
  <xhtml:link rel="alternate" hreflang="en" href="https://example.com/about"/>
  <xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/about"/>
  <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about"/>
</url>
<url>
  <loc>https://example.com/fr/about</loc>
  <lastmod>2026-04-19</lastmod>
  <xhtml:link rel="alternate" hreflang="en" href="https://example.com/about"/>
  <xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/about"/>
  <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about"/>
</url>
```

Rules:
- Only emit hreflang when a page exists in 2+ locales
- Exclude noindex variants from hreflang groups
- Each locale has its own `<lastmod>` from its sidecar
- `x-default` points to the default locale

Robots.txt: no locale-specific changes. Sitemap line already points to
`sitemap.xml` which contains all locales.

---

## Admin UI

### Page list (SiteTree)

Pages shown once with locale badges: `about [EN] [FR]`. Not shown as
separate entries per locale. Badge indicates which translations exist.

Filter: "show pages missing French translation" — surfaces translation gaps.

### Editor

Locale picker in the editor toolbar — switches between `page.json` and
`page.fr.json` for the same page. Same editor form, different content.

URL encoding: `?locale=fr` query param alongside `?target=` and `#hash`.
Example: `/pages/about/edit?locale=fr#hero`

Switching locale reloads the component tree from the locale-specific
manifest. Components, ordering, and content can differ per locale.

### "Translate" action

"Translate to French" on the about page:
1. Copies `page.json` to `page.fr.json` (same template, same components)
2. Opens the French version in the editor
3. Author edits the French content

Only creates the page locale file. Fragments are NOT auto-translated —
they fall back to the default locale independently.

### Preview

Preview renders the active locale. Route: `/preview/fr/about`.
The dev server resolves fragments using the same locale fallback chain.

### Fragment blast radius

"used on 5 pages" counts distinct pages, not locale variants.

---

## Compare and publish

Each locale file is an independent publish item:
- `pages/about/page.json` → published as the English "about" page
- `pages/about/page.fr.json` → published as the French "about" page

Compare shows locale-specific changes: "about (fr) is ahead of staging."

Publishing a subset of locales is supported — author can publish only the
3 pages that have French translations without touching the others.

---

## Edge cases

| Case | Resolution |
|------|------------|
| `page.json` + `page.en.json` when default is `en` | Validation error — `page.json` IS the default |
| Page exists in `fr` only (no default) | Valid — French-only pages are allowed |
| Fragment has no locale file for the page's locale | Falls back through chain → default |
| French page references different fragment than English | Works — each locale manifest is independent |
| Dynamic route `:slug` shared across locales | Same slug, locale prefix only: `/fr/blog/hello-world` |
| Template has hardcoded text | Templates should be content-driven — "Read more" is a content field |
| Site name localization | Site name stays global. Use a content field if locale-specific needed |
| `pt-BR` fallback to `pt` | Configured in site.config.ts `locales.fallbacks` |
| noindex on one locale but not another | Excluded from hreflang group; only visible locale gets hreflang |
| Sitemap with 500 pages × 20 locales | Single sitemap for now; add index splitting when needed |
| Locale-specific slugs (/fr/blog/bonjour) | Future — `slug` field in manifest. Same directory slug for now |
| Target with `locales: [de]` (single locale) | Treated as default — no prefix, no hreflang, no locale switching |
| Target with `locale: de` (different default) | `/about` is German, `/en/about` is English on this target |
| Target locales subset missing a page locale | Page skipped on publish — only target's locales are rendered |
| Page has `fr` but target doesn't serve `fr` | French page not published/served on that target |
| Publish to target with locale subset | Only renders locale files matching the target's locales |
| hreflang on target with locale subset | Only includes the target's locales, not all site-level locales |
| Target with no `locales` override | Inherits all site-level locales and default |
| Per-domain: hreflang across targets | Cross-domain hreflang using each target's `siteUrl` |
| Per-domain: publish order for hreflang | Publish all locale targets together, or reconcile hreflang post-publish |
| Per-domain: single-locale target hreflang | Still gets hreflang if other targets serve the same page in other locales |
| Subpath + per-domain mixed | Valid — local uses subpath, production uses per-domain |
| Per-domain: sitemap per target | Each target gets its own sitemap with its own locale subset |
| Per-domain: x-default across domains | x-default points to the site-level default locale's target siteUrl |
| Language detection: bot vs human | Googlebot sends Accept-Language but redirect is 302 — Google indexes the default URL |
| Language detection: user overrides | Cookie `locale=fr` overrides Accept-Language after explicit locale switch |
| Language detection: static hosting | Not available — requires Hono runtime. Users land on default, navigate manually |
| Language detection: per-domain targets | Not needed — the domain itself determines the locale |
| Language detection: no Accept-Language | Serves default locale, no redirect |

---

## What does NOT change

- **Templates** — receive `content.title` (string), not locale maps
- **Zod schemas** — `z.object({ title: z.string() })` unchanged
- **The editor form** — @rjsf renders from schema, no locale awareness needed
- **The save pipeline** — writes to `page.fr.json` same as `page.json`
- **The storage providers** — files are files
- **The target model** — targets are environments + optionally locale subsets

---

## Foundational checks

Locale is itself foundational dimension #2 of 13. This section answers how each of the other 12 foundational dimensions and the multi-instance discipline compose with the locale dimension, per [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

- **Multi-instance check** (discipline) — locale variant resolution is stateless: file-suffix manifests live in storage; resolver reads on demand; locale routing in the runtime is per-request. No cross-instance coordination required. SSE invalidation events for locale-specific saves broadcast to connected clients of the same instance; cross-instance via storage observation is sufficient. Locale-aware search indexes (when added at scale) follow the per-instance memo pattern from `design-cache.md` until shared cache providers are needed.

- **Scale check** — locale multiplies content count by N (where N is locales supported). At our envelope (5000 pages × 20 locale variants = 100K total page files), the file-suffix model + per-edge sidecars per locale hold. `/api/pages` summary fields include the `locales` array per page (small string array; no scale concern). Search at scale (per `design-scale.md`) is locale-scoped or locale-agnostic — design pass open question (see below). Multi-instance + scale + locale compose: each instance reads the same storage; SSE invalidations broadcast per-instance; no cross-instance locale-state coordination required.

- **Theme check** — locale + theme are peer dimensions per the locked invariants. Cross-dimension fallback is locale-priority: `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. Theme variants compose with locale variants via filename composition order (locale before theme). When pages/fragments get theme variants per `design-themes.md`, the same fallback rule extends.

- **Team check** — locale-aware role visibility: editors with read-access only to a locale subset (e.g., a French-only translator) see only French page variants in the tree. Audit log records locale-specific writes — `revision.path` includes the suffix (e.g., `pages/home/page.fr.json`). Review workflows scope to a (target, locale) pair when concrete demand surfaces (out of v1).

- **Hook check** — hooks fire per-save with locale context in the payload. `beforeSave({ item, locale })` hooks can validate / enrich / reject per-locale. Translate-to hook firings (when a locale variant is auto-created) treated as standard saves; recorded with `replayed: false` in audit log.

- **Render check** — render context carries locale; templates receive `params.locale`. Static targets pre-render per-locale at publish time. ESI assembles locale-suffixed fragments at edge. Request-time SSR (when shipped) reads locale from URL prefix or `Accept-Language` header. Render-for-analysis (validation Cut 3) caches per-locale.

- **Validation check** — validators dispatch per-item; locale variant manifests are validated as their own item, not as deltas against the default-locale variant. The `altRequired` validator (validation Cut 3) walks the schema for the variant's locale. Open question: locale-aware validation (e.g., a "missing-French-translation" validator that flags pages without a French variant when French is configured) — deferred to validation Cut 2 / Cut 3.

- **Plugin check** — plugin-supplied storage providers, AI providers, validators all see locale via the existing context shape (`params.locale`, `ResolveContext.locale`, `ValidatorInput.scope.item.locale`). Plugins inherit locale awareness without per-plugin design.

- **Cache check** — cache keys include locale where the cached value differs per-locale (page summaries, rendered output, search indexes). `AdminCache` invalidation on locale-specific save invalidates only the affected locale's cache entries. Per-locale invalidation is finer-grained than per-page; reduces cache churn at scale.

- **Offline check** — browser-side cache (`IndexedDBCache` / `LocalStorageCache` per `design-offline.md`) scopes entries by active locale. Offline locale switching reads from cached entries for the new locale; if not cached, surfaces the staleness banner. Save attempts during offline include the active locale in the queued payload; replay preserves locale context.

## Open questions for the design pass (locked / deferred)

**Locked:** the remaining items listed below have explicit triggers; trigger = the design-pass-or-implementation-work-that-resolves-them.

- **Per-field translation (#192)** — Layered overlay model on top of existing whole-file locale variants. Trigger: team-i18n use case (multiple translators editing the same page, conflict-aware merge required) materializes. The asset-side per-field overlay model (`design-media.md`) is the precedent; pages/fragments adopt the same shape.
- **Locale-specific slugs (`/fr/blog/bonjour` for `/blog/hello`)** — `slug` field in the locale variant manifest. Trigger: SEO-driven operator demand for native-language URLs. Currently same directory slug across locales is the simpler (and sufficient) default.
- **Locale-aware search index** — At scale, search across 5000 pages × 20 locales = 100K records. `design-scale.md`'s `/api/pages/search?q=` is locale-scoped today (server filter). Trigger: a real operator hits 5000+ pages × 10+ locales and surfaces search-latency pain. Until then, server-side locale-scoped substring match is sufficient.
- **Locale validators** — A "missing-translation" validator that flags pages without configured-locale variants would be a Cut 2 (background) or Cut 3 (quality) addition. Trigger: validation Cut 2 / 3 design pass picks up this item.
- **Admin "Translate to..." action** — Listed in the implementation sequence (step 12) as "Small" effort. Currently CLI-only. Trigger: editor papercut cluster picks this up alongside #103/#104 UX work, or surfaces as its own Tier 1 issue when authors ask.
- **`gazetta validate` locale-file checks** — Step 15 of the original implementation sequence. Trigger: validation Cut 5 (CLI rewrite per `design-validation-implementation.md`) picks this up.

---

## Implementation sequence

| Step | Scope | Effort | Status |
|------|-------|--------|--------|
| 1 | `locales` config in site.config.ts + type | Small | ✓ |
| 2 | Page discovery: scan `page.*.json` siblings | Small | ✓ |
| 3 | Fragment discovery: scan `fragment.*.json` | Small | ✓ |
| 4 | Route generation with locale prefix | Medium | ✓ |
| 5 | Renderer: locale param, fragment locale resolution | Medium | ✓ |
| 6 | Renderer: hreflang injection | Medium | ✓ |
| 7 | Sitemap: hreflang cross-links | Medium | ✓ |
| 8 | Publish: per-locale fragment rendering | Medium | ✓ |
| 9 | Edge runtime: locale-aware fragment fetch | Medium | ✓ |
| 10 | Admin: locale badges on pages | Small | ✓ |
| 11 | Admin: locale picker in editor | Medium | ✓ |
| 12 | Admin: "Translate to..." action | Small | ☐ |
| 13 | Admin: `?locale=` in URL | Small | ✓ |
| 14 | CLI: `gazetta translate about --to fr` | Small | ✓ |
| 15 | `gazetta validate`: locale file validation | Small | ☐ |

**Pending step triggers:**

- Step 12 (admin "Translate to..." action) lands with the editor papercut cluster (Tier 1) when author UX work picks up; or as its own issue when authors ask.
- Step 15 (`gazetta validate` locale-file checks) lands with validation Cut 5 (CLI rewrite per `design-validation-implementation.md`).

---

## Research sources

- [Google: localized versions (hreflang)](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [Google: managing multi-regional sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
- [Hugo multilingual mode](https://gohugo.io/content-management/multilingual/)
- [Astro i18n routing](https://docs.astro.build/en/guides/internationalization/)
- [Decap CMS i18n](https://decapcms.org/docs/i18n/)
- [Sanity localization](https://www.sanity.io/docs/studio/localization)
- [Contentful locales](https://www.contentful.com/developers/docs/tutorials/general/setting-locales/)
- [Storyblok i18n](https://www.storyblok.com/docs/concepts/internationalization)
- [Strapi 5 i18n](https://strapi.io/blog/strapi-5-i18n-complete-guide)
- [Payload CMS localization](https://payloadcms.com/docs/configuration/localization)
- [BCP 47 language tags](https://www.rfc-editor.org/info/bcp47)
