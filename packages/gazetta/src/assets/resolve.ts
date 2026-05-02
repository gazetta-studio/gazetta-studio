/**
 * Asset resolution — turn references stored in content JSON into the resolved
 * shapes templates receive at render time.
 *
 * Dispatches by `manifest.kind` (per Q1 lock):
 *   - embedded → `resolveEmbeddedRef`
 *   - downloadable → `resolveDownloadableRef`
 *   - font → `resolveFontRef`
 *
 * Locale + theme handled per Q3/Q4 locks:
 *   - embedded/downloadable: walker reads each variant in the cross-dimension
 *     chain (most-specific-first) and folds them onto the default with
 *     `foldLocaleChain` (most-specific-LAST after reversing). Result is one
 *     effective `Partial<AssetManifest>` passed to the kind resolver.
 *   - font: walker enumerates every (locale, theme) cell in the site's
 *     supported universe, reads each variant that exists, and passes the
 *     full Map<Selector-key, FontLocaleAdditiveManifest> to the font
 *     resolver. Fonts ADD variants (per Q3 lock); they don't override.
 *
 * # Why the walker enumerates the full universe for fonts
 *
 * The font resolver returns a union of `@font-face` declarations, each
 * with its own `unicode-range`. The browser picks per character based on
 * the active page's content. So at render time we don't know which
 * locale's font variant will be needed — we expose ALL of them. The
 * universe is the site's `themes.supported × locales.supported` cells;
 * the walker tries each one and includes the variants that exist.
 *
 * # Graceful degradation
 *
 * When a referenced asset can't be resolved (manifest missing, corrupt,
 * or storage failure), the walker returns a placeholder resolved shape
 * and logs the error. Pages continue rendering; authors see degraded
 * output instead of crashed pages (design-media.md → graceful
 * degradation).
 */
import type { ResolvedDownloadableAsset, ResolvedEmbeddedAsset, ResolvedFontAsset } from '../schema/types.js'
import type { StorageProvider } from '../types.js'
import { type Selector, buildSelector, selectorsEqual } from '../schema/dimensions.js'
import type { ResolvedLocales } from '../locale.js'
import type { ResolvedThemes } from '../themes.js'
import { crossDimensionFallbackChain } from '../selector-chain.js'
import { sharpAdapter } from '../transforms/sharp.js'
import type { TransformAdapter } from '../transforms/adapter.js'
import { AssetManifestCorruptError, AssetManifestNotFoundError } from './errors.js'
import { foldLocaleChain } from './manifest-merge.js'
import { readDefaultManifest } from './manifest-default.js'
import { localeManifestVariantFor } from './manifest-locale.js'
import { extFromMime } from './url.js'

/** Context needed to resolve a reference — shared across all refs in a render pass. */
export interface AssetResolveContext {
  /** The source target's storage provider (where manifests + bytes live). */
  storage: StorageProvider
  /** Path prefix for assets within the storage root (typically `"assets"`). */
  assetsRoot: string
  /**
   * Site URL prefix for absolute URLs. When absent, URLs are root-relative.
   * Used for targets served from a separate origin.
   */
  siteUrl?: string
  /** Active locale for this render pass. Absent = default-locale render. */
  locale?: string
  /** Active theme for this render pass. Absent = default-theme render. */
  theme?: string
  /**
   * Resolved site-level locales. Required when `locale` is set; the chain
   * builder needs the full config (default locale, fallbacks).
   */
  locales?: ResolvedLocales | null
  /**
   * Resolved site-level themes. Required when `theme` is set OR for font
   * resolution (fonts enumerate the supported theme set).
   */
  themes?: ResolvedThemes | null
  /**
   * Transform adapter — required, but defaults to `sharpAdapter` when the
   * caller doesn't supply one. The adapter owns URL composition, srcset
   * generation, and cache policy. Per-target factory at boot picks the
   * right adapter per `target.transforms` config.
   */
  transformAdapter?: TransformAdapter
}

/** Shape of an embedded-asset reference as stored in content JSON. */
interface EmbeddedRefShape {
  _asset: string
  alt?: string
  focalPoint?: { x: number; y: number }
}

/** Shape of a downloadable-asset reference as stored in content JSON. */
interface DownloadableRefShape {
  _asset: string
  title?: string
  description?: string
}

/** Shape of a font-asset reference as stored in content JSON. */
interface FontRefShape {
  _asset: string
}

// ---------- Per-kind resolvers ----------

/**
 * Resolve a single embedded-asset reference. Caller has already read the
 * default + per-locale variant and folded the chain into one effective
 * Partial. We merge that effective override on top of the default for
 * field-level overrides; bytes-presence (hash on the override) shifts
 * URL construction to the override's bytes.
 *
 * Throws on manifest not-found or corrupt — caller (the walker) catches
 * and substitutes a placeholder.
 */
export async function resolveEmbeddedRef(
  ref: EmbeddedRefShape,
  defaultManifest: import('../schema/types.js').AssetManifest,
  effectiveOverride: Partial<import('../schema/types.js').AssetManifest> | null,
  selector: Selector | null,
  ctx: AssetResolveContext,
): Promise<ResolvedEmbeddedAsset> {
  // Bytes source: when the effective override has a hash, the locale
  // has its own bytes — URL points at the locale-bytes path. Otherwise
  // URL points at the default bytes.
  const overrideHasBytes = effectiveOverride !== null && typeof effectiveOverride.hash === 'string'
  const bytesSource = overrideHasBytes ? effectiveOverride : defaultManifest
  const bytesSelector = overrideHasBytes ? selector : null

  // The merged manifest is "default with override fields applied" for
  // field reads (alt, width, height, variants, mime). Override-wins on
  // any non-undefined field.
  const merged = {
    ...defaultManifest,
    ...(effectiveOverride ?? {}),
  } as import('../schema/types.js').AssetManifest

  const ext = extFromMime(merged.mime)
  if (!ext) {
    throw new AssetManifestCorruptError(
      `${ctx.assetsRoot}/${defaultManifest.name}.asset.json`,
      new Error(`No extension known for MIME ${merged.mime}`),
    )
  }

  const adapter = ctx.transformAdapter ?? sharpAdapter
  const adapterInput = {
    name: defaultManifest.name,
    hash: bytesSource.hash!,
    ext,
    selector: bytesSelector,
    siteUrl: ctx.siteUrl,
    variants: (bytesSource.variants ?? []) as readonly import('../schema/types.js').AssetVariant[],
    width: merged.width,
    height: merged.height,
  }

  const url = adapter.primaryUrl(adapterInput)
  const srcset = adapter.srcset(adapterInput)

  // Per-ref override > merged manifest's alt > '' (decorative).
  const alt = ref.alt ?? merged.alt ?? ''

  return {
    url,
    srcset,
    width: merged.width,
    height: merged.height,
    duration: null,
    animated: false,
    poster: null,
    alt,
    focalPoint: ref.focalPoint ?? null,
    mime: merged.mime,
  }
}

/**
 * Resolve a single downloadable-asset reference. Same locale-merge
 * semantics as embedded; different resolved shape (no srcset, no
 * focal-point, has title/description).
 */
export async function resolveDownloadableRef(
  ref: DownloadableRefShape,
  defaultManifest: import('../schema/types.js').AssetManifest,
  effectiveOverride: Partial<import('../schema/types.js').AssetManifest> | null,
  selector: Selector | null,
  ctx: AssetResolveContext,
): Promise<ResolvedDownloadableAsset> {
  const overrideHasBytes = effectiveOverride !== null && typeof effectiveOverride.hash === 'string'
  const bytesSource = overrideHasBytes ? effectiveOverride : defaultManifest
  const bytesSelector = overrideHasBytes ? selector : null

  const merged = {
    ...defaultManifest,
    ...(effectiveOverride ?? {}),
  } as import('../schema/types.js').AssetManifest & { title?: string; description?: string }

  const ext = extFromMime(merged.mime)
  if (!ext) {
    throw new AssetManifestCorruptError(
      `${ctx.assetsRoot}/${defaultManifest.name}.asset.json`,
      new Error(`No extension known for MIME ${merged.mime}`),
    )
  }

  const adapter = ctx.transformAdapter ?? sharpAdapter
  const url = adapter.primaryUrl({
    name: defaultManifest.name,
    hash: bytesSource.hash!,
    ext,
    selector: bytesSelector,
    siteUrl: ctx.siteUrl,
    variants: [], // downloadable assets don't have a srcset ladder
    width: null,
    height: null,
  })

  // Title fallback chain: per-ref → merged manifest title → asset name.
  // (Today's manifest type doesn't carry `title`; step 24/post-v1 will
  // add it. Until then, the asset name is the human-readable fallback.)
  const title = ref.title ?? merged.title ?? defaultManifest.name
  const description = ref.description ?? merged.description ?? null

  return {
    url,
    title,
    description,
    size: merged.size ?? null,
    mime: merged.mime,
  }
}

/**
 * Resolve a font-asset reference. Walker has already enumerated every
 * locale/theme variant that exists; we receive them as a Map. The
 * resolved shape carries the full union — templates emit one
 * `@font-face` per variant.
 *
 * Today's manifest type doesn't yet carry font-specific fields
 * (`cssName`, `format`, `weight`, `style`, `unicodeRange`) — those
 * land when ingest learns to write fonts. Until then, we synthesize
 * sensible defaults from the asset name and MIME. The shape and
 * dispatch are correct from day one; the field set fills in
 * incrementally.
 */
/** A font variant paired with the selector that addresses its bytes. */
export interface FontVariantEntry {
  selector: Selector
  manifest: import('../schema/types.js').FontLocaleAdditiveManifest
}

export async function resolveFontRef(
  _ref: FontRefShape,
  defaultManifest: import('../schema/types.js').AssetManifest,
  variants: readonly FontVariantEntry[],
  ctx: AssetResolveContext,
): Promise<ResolvedFontAsset> {
  const ext = extFromMime(defaultManifest.mime)
  if (!ext) {
    throw new AssetManifestCorruptError(
      `${ctx.assetsRoot}/${defaultManifest.name}.asset.json`,
      new Error(`No extension known for MIME ${defaultManifest.mime}`),
    )
  }

  // CSS family name: stable per asset (Gazetta-owned identifier per
  // design-media.md). Today's manifest doesn't carry `cssName`, so
  // derive from the asset name.
  const cssName = defaultManifest.name

  const adapter = ctx.transformAdapter ?? sharpAdapter

  // Default variant is always present in the union — every font has
  // its default file.
  const resolved: ResolvedFontAsset['variants'] = [
    {
      url: adapter.primaryUrl({
        name: defaultManifest.name,
        hash: defaultManifest.hash,
        ext,
        selector: null,
        siteUrl: ctx.siteUrl,
        variants: [],
        width: null,
        height: null,
      }),
      format: deriveFontFormat(ext),
      weight: 400,
      style: 'normal',
      unicodeRange: null,
      mime: defaultManifest.mime,
    },
  ]

  // Add each locale/theme variant. URL embeds the variant's selector so
  // the bytes file for that variant resolves correctly.
  for (const { selector, manifest: variant } of variants) {
    const variantExt = extFromMime(variant.mime) ?? ext
    resolved.push({
      url: adapter.primaryUrl({
        name: defaultManifest.name,
        hash: variant.hash,
        ext: variantExt,
        selector,
        siteUrl: ctx.siteUrl,
        variants: [],
        width: null,
        height: null,
      }),
      format: variant.format,
      weight: variant.weight,
      style: variant.style,
      unicodeRange: variant.unicodeRange,
      mime: variant.mime,
    })
  }

  return {
    cssName,
    variants: resolved,
  }
}

function deriveFontFormat(ext: string): 'woff2' | 'woff' | 'ttf' | 'otf' {
  switch (ext) {
    case 'woff2':
      return 'woff2'
    case 'woff':
      return 'woff'
    case 'ttf':
      return 'ttf'
    case 'otf':
      return 'otf'
    default:
      return 'woff2'
  }
}

// ---------- Walker ----------

/** Placeholder returned when a reference can't be resolved. */
const EMBEDDED_PLACEHOLDER: ResolvedEmbeddedAsset = {
  url: '/assets/__missing__.svg',
  srcset: null,
  width: null,
  height: null,
  duration: null,
  animated: false,
  poster: null,
  alt: '',
  focalPoint: null,
  mime: 'image/svg+xml',
}

const DOWNLOADABLE_PLACEHOLDER: ResolvedDownloadableAsset = {
  url: '/assets/__missing__',
  title: '(missing asset)',
  description: null,
  size: null,
  mime: 'application/octet-stream',
}

const FONT_PLACEHOLDER: ResolvedFontAsset = {
  cssName: '__missing__',
  variants: [],
}

/** Structural check — is this value an asset reference (any kind)? */
function isAssetRef(value: unknown): value is { _asset: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v._asset === 'string'
}

/**
 * Walk a content object and resolve every asset reference found. Returns a
 * new content object with references swapped for resolved shapes; arrays and
 * nested objects are recursed into. Non-ref values are copied unchanged.
 *
 * Graceful degradation: references that fail to resolve are replaced with a
 * placeholder. Errors are logged but don't halt rendering.
 */
export async function resolveAssetRefs(
  content: Record<string, unknown> | undefined,
  ctx: AssetResolveContext,
): Promise<Record<string, unknown> | undefined> {
  if (!content) return content
  return (await walk(content, ctx)) as Record<string, unknown>
}

async function walk(value: unknown, ctx: AssetResolveContext): Promise<unknown> {
  if (isAssetRef(value)) {
    try {
      return await resolveOne(value, ctx)
    } catch (err) {
      if (err instanceof AssetManifestNotFoundError || err instanceof AssetManifestCorruptError) {
        // eslint-disable-next-line no-console
        console.warn(`[asset-resolver] ${err.message}`)
        // Return the most generic placeholder — the walker can't know
        // the kind without successfully reading the manifest. Embedded's
        // placeholder shape carries the most fields, so it satisfies any
        // template that conditionally checks fields like `srcset`.
        return EMBEDDED_PLACEHOLDER
      }
      throw err
    }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(item => walk(item, ctx)))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = await walk(v, ctx)
    }
    return result
  }
  return value
}

/**
 * Resolve one asset reference. Reads default first to discover kind,
 * then dispatches to the kind-specific path with appropriate locale/
 * theme handling.
 */
async function resolveOne(
  ref: { _asset: string },
  ctx: AssetResolveContext,
): Promise<ResolvedEmbeddedAsset | ResolvedDownloadableAsset | ResolvedFontAsset> {
  const defaultManifest = await readDefaultManifest(ctx.storage, ctx.assetsRoot, ref._asset)

  switch (defaultManifest.kind) {
    case 'font': {
      const variants = await readAllFontVariants(defaultManifest.name, ctx)
      return resolveFontRef(ref as FontRefShape, defaultManifest, variants, ctx)
    }
    case 'downloadable': {
      const { effective, selector } = await readEffectiveLocaleOverride(defaultManifest.name, 'downloadable', ctx)
      return resolveDownloadableRef(ref as DownloadableRefShape, defaultManifest, effective, selector, ctx)
    }
    case 'embedded':
    default: {
      const { effective, selector } = await readEffectiveLocaleOverride(defaultManifest.name, 'embedded', ctx)
      return resolveEmbeddedRef(ref as EmbeddedRefShape, defaultManifest, effective, selector, ctx)
    }
  }
}

/**
 * Read the cross-dimension fallback chain for an asset's name + kind,
 * fold the per-field overrides onto a fresh base, and return the
 * effective override along with the selector that produced bytes (if
 * any).
 *
 * Returns:
 *   - effective: Partial<AssetManifest> — undefined-shaped fields show
 *     "no override"; defined fields show "this locale wins."
 *   - selector: the most-specific selector that contributed bytes (i.e.
 *     had a `hash`); null if no override has bytes.
 */
async function readEffectiveLocaleOverride(
  name: string,
  kind: 'embedded' | 'downloadable',
  ctx: AssetResolveContext,
): Promise<{ effective: Partial<import('../schema/types.js').AssetManifest> | null; selector: Selector | null }> {
  const chain = crossDimensionFallbackChain({
    locale: ctx.locale,
    theme: ctx.theme,
    locales: ctx.locales ?? null,
    themes: ctx.themes ?? null,
  })
  if (chain.length === 0) {
    return { effective: null, selector: null }
  }

  // Read each variant in the chain. `crossDimensionFallbackChain` returns
  // most-specific-FIRST. `foldLocaleChain` expects most-specific-LAST,
  // so we reverse before fold (and pick the first hash-carrying entry,
  // also walking most-specific-first, for the bytes selector).
  const variant = localeManifestVariantFor(kind)
  const overrides: Array<{ selector: Selector; manifest: Partial<import('../schema/types.js').AssetManifest> | null }> =
    []
  for (const sel of chain) {
    const manifest = (await variant.read(ctx.storage, ctx.assetsRoot, name, sel)) as Partial<
      import('../schema/types.js').AssetManifest
    > | null
    overrides.push({ selector: sel, manifest })
  }

  // Pick the bytes selector — first override (most-specific) with a hash.
  let bytesSelector: Selector | null = null
  for (const o of overrides) {
    if (o.manifest && typeof o.manifest.hash === 'string') {
      bytesSelector = o.selector
      break
    }
  }

  // Fold: reverse so least-specific applies first; most-specific overwrites.
  const reversed = overrides
    .slice()
    .reverse()
    .map(o => o.manifest)
  const effective = foldLocaleChain<Partial<import('../schema/types.js').AssetManifest>>({}, reversed)
  return { effective: Object.keys(effective).length > 0 ? effective : null, selector: bytesSelector }
}

/**
 * Read every locale/theme font variant that exists. Walker enumerates
 * the site's `themes.supported × locales.supported` cells (excluding
 * the all-default cell, which is the default manifest read separately)
 * and collects the variants returned non-null.
 *
 * Returns a Map keyed by selector identity (built from JSON.stringify
 * of the selector entries) for downstream iteration. Today's caller
 * just iterates the values — the key is for de-duplication only.
 */
async function readAllFontVariants(name: string, ctx: AssetResolveContext): Promise<readonly FontVariantEntry[]> {
  const out: FontVariantEntry[] = []
  const variant = localeManifestVariantFor('font')

  // Universe = configured (locale, theme) cells. Default-locale +
  // default-theme is excluded — that's the default manifest, read
  // separately. When neither dimension is configured, there are no
  // variants to look up.
  const localeCells = ctx.locales?.supported ?? []
  const themeCells = ctx.themes?.supported ?? []
  const candidates: Selector[] = []
  for (const loc of localeCells) {
    if (loc === ctx.locales?.default) continue
    const sel = buildSelector({ locale: loc })
    if (sel) candidates.push(sel)
  }
  for (const th of themeCells) {
    if (th === ctx.themes?.default) continue
    const sel = buildSelector({ theme: th })
    if (sel) candidates.push(sel)
  }
  for (const loc of localeCells) {
    if (loc === ctx.locales?.default) continue
    for (const th of themeCells) {
      if (th === ctx.themes?.default) continue
      const sel = buildSelector({ locale: loc, theme: th })
      if (sel) candidates.push(sel)
    }
  }

  for (const sel of candidates) {
    const m = await variant.read(ctx.storage, ctx.assetsRoot, name, sel)
    if (m) {
      out.push({ selector: sel, manifest: m as import('../schema/types.js').FontLocaleAdditiveManifest })
    }
  }
  return out
}

// Re-export so external callers continue to import `selectorsEqual`-style
// helpers from this module if needed for tests. Pure pass-through.
export { selectorsEqual }
