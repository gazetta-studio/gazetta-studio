/**
 * Route-level orchestration for `POST /api/assets/:name/suggest-alt`.
 *
 * This module owns the wiring between the admin-api HTTP layer and the
 * alt-text task: loads the asset manifest, reads bytes from storage,
 * builds the suggester, runs it, returns the response body.
 *
 * Lives outside `admin-api/routes/assets.ts` so route handlers stay
 * thin (HTTP concerns only) and the orchestration is unit-testable
 * without spinning up Hono.
 *
 * # SOLID
 *
 *   - SRP: this module owns "given a name + locale + storage + site,
 *     return a suggestion or a typed error". No HTTP concerns; no
 *     adapter construction (delegates to `buildAltAdapter`).
 *   - DIP: depends on `StorageProvider` + `SiteManifest` + factory
 *     functions, never on a specific provider. Tests substitute via
 *     the same abstractions.
 *   - OCP: adding response fields (e.g., locale fallback used) is one
 *     additional field on the returned shape; no changes to the route.
 */
import { readManifest } from '../assets/manifest.js'
import { assetStoragePaths } from '../assets/asset-paths.js'
import { AssetManifestNotFoundError } from '../assets/errors.js'
import type { GazettaManifest, SiteManifest, StorageProvider, TargetConfig } from '../types.js'
import { buildAltAdapter } from './factory.js'
import { resolveAltConfig } from './config.js'
import { createAltSuggester } from './suggester.js'

/**
 * Result of orchestration. The route handler maps these to HTTP
 * responses uniformly:
 *
 *   - `'unavailable'` → 503 (no adapter / unsupported MIME)
 *   - `'failed'`      → 502 (adapter threw)
 *   - `'not-found'`   → 404 (asset doesn't exist)
 *   - `'ok'`          → 200 (with body, including possible refused: true)
 */
export type SuggestAltResult =
  | { kind: 'ok'; suggestion: { text: string; refused: boolean; refusalReason: string | null } }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'not-found'; message: string }

export interface SuggestAltOptions {
  /** Asset name (from `:name` URL param). */
  name: string
  /** Where assets live in storage (typically `'assets'`). */
  assetsRoot: string
  /** Storage provider for the resolved target. */
  storage: StorageProvider
  /** Site manifest carrying `ai:` and `altText:` blocks. */
  site: Pick<SiteManifest, 'ai' | 'altText'>
  /** Resolved target config (target-level overrides applied via factory). */
  target: Pick<TargetConfig, 'altText'> | undefined
  /** Optional gazetta-level manifest; first rung of the three-rung chain. */
  gazetta?: Pick<GazettaManifest, 'ai' | 'altText'>
  /** Locale to generate alt in. Defaults to 'en' upstream. */
  locale: string
  /** Optional AbortSignal forwarded to the adapter. */
  signal?: AbortSignal
}

/**
 * Run an alt-text suggestion for an existing asset. Pure orchestration
 * — no HTTP, no logging, no streaming. Returns a structured result
 * that the route handler maps to HTTP.
 */
export async function suggestAltForAsset(opts: SuggestAltOptions): Promise<SuggestAltResult> {
  // Resolve config first to validate the feature is configured for
  // this site/target. No adapter construction yet — cheap.
  const resolved = resolveAltConfig(opts.site, opts.target, opts.gazetta)
  if (!resolved) {
    return {
      kind: 'unavailable',
      message: 'AI alt-text is not configured for this site. Add an `altText:` block to site.config.ts.',
    }
  }

  // Load the asset manifest. Wrapped in try/catch so we surface
  // missing-asset as a typed result rather than letting the asset
  // domain's typed error escape into the route handler's
  // pattern-match list.
  let manifest: Awaited<ReturnType<typeof readManifest>>
  try {
    manifest = await readManifest(opts.storage, opts.assetsRoot, opts.name)
  } catch (err) {
    if (err instanceof AssetManifestNotFoundError) {
      return { kind: 'not-found', message: `Asset '${opts.name}' not found` }
    }
    // Other asset-domain errors bubble — they indicate misconfiguration
    // (e.g., corrupt manifest), which the route handler maps via
    // `respondWithAssetError`.
    throw err
  }

  // Build the adapter via the factory. Returns nullAltAdapter when no
  // provider is configured — the suggester's `available()` check
  // surfaces this as `false` and we map to 503.
  const adapter = buildAltAdapter(opts.site, opts.target, opts.gazetta)
  const suggester = createAltSuggester({ adapter })

  if (!suggester.available(manifest.mime)) {
    return {
      kind: 'unavailable',
      message: `AI alt-text adapter unavailable. Check that '${resolved.provider.name}' credentials are valid and that the asset MIME (${manifest.mime}) is supported.`,
    }
  }

  // Resolve the bytes path for the default-locale variant. v1.5
  // suggests against the asset's default bytes regardless of the
  // requested locale — locale only affects the prompt language. Future
  // locale-specific bytes (e.g., a French-text-overlay version) could
  // route through the override slices; deferred until a real consumer
  // requests it.
  const paths = assetStoragePaths(opts.assetsRoot, manifest)

  let bytes: Uint8Array
  try {
    bytes = await opts.storage.readBytes(paths.defaultBytes)
  } catch (err) {
    return {
      kind: 'failed',
      message: `Could not read asset bytes for '${opts.name}': ${err instanceof Error ? err.message : 'unknown error'}`,
    }
  }

  // Optional poster bytes for animated images — the analyzer extracts
  // them at upload time and writes a manifest path; we forward to the
  // suggester so vision-prep skips re-rasterization.
  let posterBytes: Uint8Array | undefined
  if (manifest.poster) {
    try {
      posterBytes = await opts.storage.readBytes(`${opts.assetsRoot}/${manifest.poster}`)
    } catch {
      // Poster missing or unreadable — fall through to source bytes.
      // Vision-prep handles the rasterize-source path.
      posterBytes = undefined
    }
  }

  const suggestion = await suggester.suggest(
    {
      bytes,
      mime: manifest.mime,
      hash: manifest.hash,
      locale: opts.locale,
      maxImageEdge: resolved.maxImageEdge,
      posterBytes,
    },
    opts.signal,
  )

  if (suggestion === null) {
    // The suggester returns null on capability miss, abort, or any
    // typed AI error. We've already verified availability above, so
    // here the cause is most likely a transport failure.
    return {
      kind: 'failed',
      message: `Alt-text generation failed. Check ${resolved.provider} status and retry.`,
    }
  }

  return { kind: 'ok', suggestion }
}
