# Template Assets

How to use Gazetta's media library from a template — schema declaration,
resolved shape, rendering, and the per-reference override surface.

For the design model (kinds, override dimensions, storage layout) see
[`.claude/rules/design-media.md`](../.claude/rules/design-media.md). This
doc is the practical "I'm writing a template" guide.

## Quickstart

A template that uses one image asset:

```ts
// templates/hero/index.tsx
import type { TemplateFunction } from 'gazetta'
import { z } from 'zod'
import { embeddedAsset, type Content } from 'gazetta/schema'

export const schema = z.object({
  hero: embeddedAsset({ accept: ['image'] }),
  title: z.string(),
})

const render: TemplateFunction<Content<typeof schema>> = ({ content }) => ({
  html: `
    <section>
      <img
        src="${content.hero.url}"
        srcset="${content.hero.srcset ?? ''}"
        alt="${content.hero.alt}"
        width="${content.hero.width ?? ''}"
        height="${content.hero.height ?? ''}">
      <h1>${content.title}</h1>
    </section>
  `,
  css: '',
  js: '',
})

export default render
```

Three things make this work:

1. **`embeddedAsset({ accept: ['image'] })`** — schema helper that
   declares "this field is an asset reference; the picker should only
   show images." Authors see a picker UI with the image filter applied;
   the page manifest stores `{ "_asset": "hero" }`.
2. **`Content<typeof schema>`** — type utility that walks the Zod
   schema and swaps reference shapes for resolved shapes. The template
   sees `{ url, srcset, width, height, alt, ... }` instead of
   `{ _asset: "hero" }`.
3. **`content.hero.url`** — at render time, the resolver has already
   read the asset manifest and constructed the URL.

## Schema helpers

Three helpers exposed by `gazetta/schema`:

| Helper | Asset kind | Use for |
|---|---|---|
| `embeddedAsset()` | image / video / audio | `<img>`, `<video>`, `<audio>` — anything rendered inline |
| `downloadable()` | document (PDF, ZIP, etc.) | `<a href download>` — links offered for download |
| `fontAsset()` | font | `@font-face` declarations |

### `embeddedAsset(options)`

```ts
embeddedAsset({
  accept?: AcceptFilter[]         // ['image'], ['image/png'], ['image/']
  altOverride?: boolean           // default true (images), false (others)
  altRequired?: boolean           // default false; warns at save when null
  focalPointOverride?: boolean    // default true (images)
})
```

`accept` is the picker filter. Three forms:
- **kind name** — `'image'`, `'video'`, `'audio'`, `'document'`, `'font'`, `'other'`
- **MIME prefix** — `'image/'` (everything starting `image/`)
- **exact MIME** — `'image/svg+xml'`

Multiple entries OR-merge: `accept: ['image', 'video']` means images
*or* videos.

### `downloadable(options)`

```ts
downloadable({
  accept?: AcceptFilter[]
  titleOverride?: boolean
  descriptionOverride?: boolean
})
```

For PDF / ZIP / DOCX / etc. links the visitor downloads.

### `fontAsset(options)`

```ts
fontAsset({
  accept?: ('woff2' | 'woff' | 'ttf' | 'otf')[]
  variable?: boolean
})
```

Fonts compose differently: each locale variant *adds* a `@font-face`
entry to the union (rather than overriding bytes), and the resolved
shape carries every variant the asset has registered.

## Resolved shapes

The template receives the resolved shape — never the raw `{_asset}`
reference. The resolver does this work between manifest read and
template invocation.

### `ResolvedEmbeddedAsset`

```ts
type ResolvedEmbeddedAsset = {
  url: string                              // absolute or root-relative
  srcset: string | null                    // null for SVG, animated, no variants
  width: number | null
  height: number | null
  duration: number | null                  // video / audio / animated images
  animated: boolean                        // GIF/APNG/animated WebP/AVIF
  poster: string | null                    // first-frame URL for animated
  alt: string                              // ALWAYS a string (resolver folds null → '')
  focalPoint: { x: number; y: number } | null
  mime: string
}
```

Notes:
- **`alt` is always a string.** The three-state model (`string`, `''`,
  `null`) lives at the manifest layer; the resolver folds `null` to
  `''` so templates can `alt="${content.hero.alt}"` without conditional
  logic. Decorative images render `alt=""` — correct per WCAG.
- **`srcset` is null when there's nothing useful to put in it.** SVG
  is vector; animated images don't have a width ladder; manifests
  whose variants haven't been generated yet.
- **`focalPoint` defaults to null.** Templates that crop to non-original
  aspect ratios use this — `object-position: ${x*100}% ${y*100}%` puts
  the subject in frame.

### `ResolvedDownloadableAsset`

```ts
type ResolvedDownloadableAsset = {
  url: string
  title: string                            // ALWAYS a string (folds null → '')
  description: string | null
  size: number | null
  mime: string
}
```

### `ResolvedFontAsset`

```ts
type ResolvedFontAsset = {
  cssName: string                          // stable family name, owned by Gazetta
  variants: Array<{
    url: string
    format: 'woff2' | 'woff' | 'ttf' | 'otf'
    weight: number | 'variable'
    style: 'normal' | 'italic'
    unicodeRange: string | null            // per-variant range for multi-script
    mime: string
  }>
}
```

Templates emit one `@font-face` per variant + a `font-family` rule
referencing `cssName`:

```ts
css: content.bodyFont.variants.map(v => `
  @font-face {
    font-family: '${content.bodyFont.cssName}';
    src: url('${v.url}') format('${v.format}');
    font-weight: ${v.weight};
    font-style: ${v.style};
    ${v.unicodeRange ? `unicode-range: ${v.unicodeRange};` : ''}
  }
`).join('') + `
  body { font-family: '${content.bodyFont.cssName}', sans-serif; }
`
```

Browser picks the right variant per character based on `unicode-range`
— same pattern as Google Fonts' multi-script families.

## Per-reference overrides

Authors can override `alt` and `focalPoint` per-use, on top of the
asset's defaults. Stored on the page manifest where the ref lives:

```json
{
  "hero": {
    "_asset": "home-banner",
    "alt": "Headline image for the homepage",
    "focalPoint": { "x": 0.3, "y": 0.4 }
  }
}
```

The resolver merges per-ref → asset → null, in that order. For alt:
- Per-ref `alt: "string"` wins → resolved alt is that string
- Per-ref `alt` absent → fall back to asset's `alt`
- Asset `alt: null` → resolved alt is `""` (decorative — and the
  admin's library card surfaces a "no alt" badge to nag the author)

Templates don't need to know which layer won; they just read
`content.hero.alt`.

## Type utility: `Content<T>`

`Content<T>` walks a Zod-inferred type and swaps:

| Reference shape | → | Resolved shape |
|---|---|---|
| `{ _asset: string, alt?, focalPoint? }` (embedded) | → | `ResolvedEmbeddedAsset` |
| `{ _asset: string, title?, description? }` (downloadable) | → | `ResolvedDownloadableAsset` |
| `{ _asset: string }` (font) | → | `ResolvedFontAsset` |
| Anything else | → | unchanged |

Recursive — works inside arrays and nested objects:

```ts
const schema = z.object({
  gallery: z.array(
    z.object({
      photo: embeddedAsset({ accept: ['image'] }),
      caption: z.string(),
    }),
  ),
})

type C = Content<typeof schema>
// type C = {
//   gallery: { photo: ResolvedEmbeddedAsset; caption: string }[]
// }
```

## Custom field hookups

For specialized editing — focal-point picker that's part of the field,
custom asset filters — use the existing `meta({ field })` pattern with
custom field components in `admin/fields/`. The asset-picker affordance
itself is built into the default rjsf widget; custom fields are for
field-specific UX beyond what the picker provides.

## Common patterns

### Optional asset

```ts
const schema = z.object({
  hero: embeddedAsset({ accept: ['image'] }).optional(),
})

const render: TemplateFunction<Content<typeof schema>> = ({ content }) => ({
  html: content.hero
    ? `<img src="${content.hero.url}" alt="${content.hero.alt}">`
    : '',
  css: '',
  js: '',
})
```

### Multiple aspect-ratio crops

The browser does the cropping via `object-position` driven by the
focal point:

```ts
html: `
  <picture style="aspect-ratio: 16/9">
    <img
      src="${content.hero.url}"
      srcset="${content.hero.srcset ?? ''}"
      style="object-fit: cover; object-position: ${
        content.hero.focalPoint
          ? `${content.hero.focalPoint.x * 100}% ${content.hero.focalPoint.y * 100}%`
          : '50% 50%'
      }"
      alt="${content.hero.alt}">
  </picture>
`
```

The library's detail-pane focal-point editor previews these exact
crops live, so authors see the same result you'll render.

### Required alt at the schema level

```ts
embeddedAsset({ accept: ['image'], altRequired: true })
```

Marks the field. The admin reads this when warning about missing alt.
(Save-time enforcement of `altRequired` is a v1.5 follow-up — today
the asset-level "no alt" badge surfaces the issue but doesn't block.)

## Things to avoid

- **Don't store the URL directly in content.** Always use `_asset`
  references. URLs change when bytes change (the hash is in the URL);
  rename rewrites references; replace-and-delete tracks references.
  Hard-coded URLs break all three.
- **Don't fall back to `<img>` shape for non-images.** `embeddedAsset`
  filters by `accept` for a reason; rendering a PDF asset with an
  `<img>` tag produces a broken image. Use `downloadable()` for files
  that should link.
- **Don't normalize `content.hero.alt` yourself.** The resolver does
  the three-state → string fold. If you see `null`, something upstream
  is broken; file a bug rather than working around it.

## See also

- [`.claude/rules/design-media.md`](../.claude/rules/design-media.md) — full design model
- [content-assets.md](content-assets.md) — author-facing guide
- [migration.md](migration.md) — migrating from `z.string()` URLs
- [transform-adapters.md](transform-adapters.md) — switching image delivery (sharp → Cloudflare)
