/**
 * Default-manifest I/O + validation.
 *
 * Single responsibility: read, validate, and narrow a `{name}.asset.json`
 * file into an `AssetManifest`. Counterpart to `manifest-locale.ts` which
 * handles `{name}.asset.{...}.json` locale variants.
 *
 * # Kind-discriminated validation
 *
 * Today's `AssetManifest` type carries a `kind: 'embedded' | 'downloadable'
 * | 'font'` discriminator but the three kinds share the same field set —
 * ingest writes everything as `kind: 'embedded'` (the v1 slice). Step 17
 * adds kind-specific fields (font: `cssName`/`format`/`weight`/`style`;
 * downloadable: `title`). When those land, this validator is the one
 * place that enforces "if kind is X, fields A/B/C must be present."
 *
 * Today's per-kind contract is uniform — all three kinds require the
 * same field set. That's fine: this validator's structure is
 * kind-discriminated even when the current rules don't yet diverge.
 * Adding a kind-specific check later is one entry in the rules table,
 * not a refactor.
 *
 * # Why a separate module from manifest.ts
 *
 * `manifest.ts` owns shared filename composition (`manifestPath`,
 * `assetBytesPath`, etc.) used by both default and locale paths. This
 * module owns default-side I/O + validation specifically. The split
 * means `manifest-locale.ts` doesn't have to depend on the default
 * validation rules and vice versa.
 */
import type { StorageProvider } from '../types.js'
import type { AssetKind, AssetManifest, AssetVariant } from '../schema/types.js'
import { AssetManifestCorruptError, AssetManifestNotFoundError, AssetStorageError } from './errors.js'
import { manifestPath } from './manifest.js'

/**
 * Read a default asset manifest from storage. Throws:
 *   - `AssetManifestNotFoundError` when the manifest file doesn't exist
 *   - `AssetManifestCorruptError` when it exists but doesn't validate
 *   - `AssetStorageError` on any other storage failure
 *
 * Default manifests are required (vs. locale manifests which are optional);
 * an asset that has no `{name}.asset.json` doesn't exist.
 */
export async function readDefaultManifest(
  storage: StorageProvider,
  assetsRoot: string,
  assetName: string,
): Promise<AssetManifest> {
  const path = `${assetsRoot}/${manifestPath(assetName)}`

  const exists = await storage.exists(path).catch(err => {
    throw new AssetStorageError('stat', path, err)
  })
  if (!exists) throw new AssetManifestNotFoundError(assetName)

  let raw: string
  try {
    raw = await storage.readFile(path)
  } catch (err) {
    throw new AssetStorageError('read', path, err)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new AssetManifestCorruptError(path, err)
  }

  if (!isDefaultManifest(parsed)) {
    throw new AssetManifestCorruptError(path, new Error('manifest shape mismatch'))
  }

  return parsed
}

/**
 * Type guard: narrow a parsed-JSON value to `AssetManifest`.
 *
 * Validation order:
 *   1. Common identity fields (version, name, kind, source)
 *   2. Per-kind required field rules (today: same set across kinds; the
 *      switch is in place for step 17's kind-specific divergence)
 *   3. Common metadata fields (alt, uploadedAt, uploadedBy)
 *
 * Returns `false` on any failure — callers translate to
 * `AssetManifestCorruptError` for I/O paths.
 */
export function isDefaultManifest(candidate: unknown): candidate is AssetManifest {
  if (!candidate || typeof candidate !== 'object') return false
  const m = candidate as Record<string, unknown>

  // 1. Identity fields (always present, never override-able)
  if (m.version !== 1) return false
  if (typeof m.name !== 'string') return false
  if (m.kind !== 'embedded' && m.kind !== 'downloadable' && m.kind !== 'font') return false
  if (m.source !== 'internal') return false

  // 2. Per-kind required fields. Today all kinds require the same byte-
  // describing set; step 17 will diverge fonts (add cssName/format/etc.)
  // and downloadables (add title). This switch reserves the dispatch
  // shape so adding a per-kind rule is an additive change.
  if (!validateByteFields(m)) return false
  switch (m.kind as AssetKind) {
    case 'embedded':
      // No additional fields beyond byte-describing today.
      break
    case 'downloadable':
      // Step 17 will add: typeof m.title === 'string', etc.
      break
    case 'font':
      // Step 17 will add: cssName, format, weight, style, optional
      // unicodeRange, etc.
      break
  }

  // 3. Common metadata
  if (m.alt !== null && typeof m.alt !== 'string') return false
  if (typeof m.uploadedAt !== 'string') return false
  if (typeof m.uploadedBy !== 'string') return false

  return true
}

/**
 * Byte-describing field validator. All three kinds today require the
 * same set: mime, size, hash, width/height (or null), variants array.
 * Extracted as a helper so the kind-specific switch above can compose
 * it cleanly when a future kind needs different bytes contract (e.g.
 * font subsetting changing what `variants` means).
 */
function validateByteFields(m: Record<string, unknown>): boolean {
  if (typeof m.mime !== 'string') return false
  if (typeof m.size !== 'number') return false
  if (typeof m.hash !== 'string') return false
  if (m.width !== null && typeof m.width !== 'number') return false
  if (m.height !== null && typeof m.height !== 'number') return false
  if (!Array.isArray(m.variants)) return false
  if (!m.variants.every(isAssetVariant)) return false
  return true
}

function isAssetVariant(candidate: unknown): candidate is AssetVariant {
  if (!candidate || typeof candidate !== 'object') return false
  const v = candidate as Record<string, unknown>
  return typeof v.width === 'number' && typeof v.path === 'string' && typeof v.size === 'number'
}
