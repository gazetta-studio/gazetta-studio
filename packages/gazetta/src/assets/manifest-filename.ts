/**
 * Asset manifest filename parsing — the inverse of `manifestPath` /
 * `selectorSuffix`. Given a filename on disk, extract the asset name and
 * (locale, theme) selector. Used by `enumerateAssetStoragePaths` to find
 * existing locale/theme override manifests without trusting filename
 * conventions blindly.
 *
 * Single responsibility: filename ↔ (assetName, selector). No I/O, no
 * disambiguation across asset names, no schema awareness. Pure.
 *
 * Grammar (per design-media.md and dimensions.ts):
 *   {name}.asset.json                          → default manifest, selector=null
 *   {name}.asset.{locale}.json                 → locale-only override
 *   {name}.asset.{theme}.json                  → theme-only override
 *   {name}.asset.{locale}.{theme}.json         → locale + theme
 *
 * Selector tokens:
 *   - locale: BCP 47 (lowercase), validated by `isValidLocale`
 *   - theme: lowercase ASCII non-locale token, validated by `isValidTheme`
 *
 * Per `DIMENSION_ORDER` (locale before theme), classification is:
 *   - 1 token: locale OR theme — try locale first; theme on miss
 *   - 2 tokens: first is locale, second is theme. The first token MUST
 *     validate as a locale and the second MUST validate as a theme — any
 *     other shape is rejected (no slot reordering, no theme-then-locale).
 *
 * Adding a future dimension: extend the recognized-tokens loop to walk
 * `DIMENSION_ORDER` and try each dimension's validator in turn. Today
 * the closed two-dimension grammar lets us hardcode the cases for
 * clarity.
 */
import { buildSelector, type Selector } from '../schema/dimensions.js'
import { isValidLocale } from '../locale.js'
import { isValidTheme } from '../themes.js'

/**
 * Parsed manifest filename. Carries the asset name and the selector
 * extracted from the suffix. `selector === null` means default manifest.
 */
export interface ParsedManifestFilename {
  readonly assetName: string
  readonly selector: Selector | null
}

/**
 * Try to parse `filename` as an asset manifest. Returns `null` when:
 *   - the filename doesn't end in `.asset.json` (or `.asset.X.json` etc.)
 *   - any selector token fails its validator
 *   - the asset name (everything before `.asset`) is empty
 *
 * Strict — invalid selector tokens are rejected outright, not coerced.
 * Callers that scan a directory pass every entry through this; matches
 * surface as overrides, misses are skipped (could be unrelated files).
 */
export function parseManifestFilename(filename: string): ParsedManifestFilename | null {
  if (!filename.endsWith('.json')) return null
  // Strip the trailing `.json`.
  const withoutExt = filename.slice(0, -'.json'.length)
  // Find the `.asset` marker. The asset name is everything before it;
  // the selector tokens are everything after (dot-separated).
  const markerIdx = withoutExt.lastIndexOf('.asset')
  if (markerIdx < 0) return null
  const assetName = withoutExt.slice(0, markerIdx)
  const afterMarker = withoutExt.slice(markerIdx + '.asset'.length)
  if (assetName.length === 0) return null

  // Default manifest — no selector tokens.
  if (afterMarker.length === 0) {
    return { assetName, selector: null }
  }

  // Selector tokens follow as `.token1` or `.token1.token2`. Anything
  // else (no leading dot, empty token from `..`) is invalid.
  if (!afterMarker.startsWith('.')) return null
  const tokens = afterMarker.slice(1).split('.')
  if (tokens.length === 0 || tokens.length > 2) return null
  if (tokens.some(t => t.length === 0)) return null

  const selector = classifySelectorTokens(tokens)
  if (selector === null) return null
  return { assetName, selector }
}

/**
 * Classify selector tokens into a Selector. Returns null if the tokens
 * don't form a valid (locale?, theme?) shape per the grammar.
 *
 * One-token forms try locale first, then theme. Both validators reject
 * each other's shapes (theme rejects BCP 47; isValidLocale rejects
 * lowercase-only non-BCP-47), so the order is unambiguous in practice
 * and this preference matters only for the rare case where both
 * validators accept (which the validators are designed not to do).
 */
function classifySelectorTokens(tokens: readonly string[]): Selector | null {
  if (tokens.length === 1) {
    const t = tokens[0]!
    if (isValidLocale(t)) return buildSelector({ locale: t })
    if (isValidTheme(t)) return buildSelector({ theme: t })
    return null
  }
  // Two tokens: locked order is locale, then theme.
  const [t1, t2] = tokens as [string, string]
  if (!isValidLocale(t1)) return null
  if (!isValidTheme(t2)) return null
  return buildSelector({ locale: t1, theme: t2 })
}
