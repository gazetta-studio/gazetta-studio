/**
 * Update an asset's metadata (alt today; tags, focalPoint, title,
 * description as those land).
 *
 * Single responsibility: merge a metadata patch into the existing
 * default manifest, validate, persist, record history. Doesn't touch
 * bytes, doesn't enumerate paths, doesn't scan refs.
 *
 * Three-state alt semantics (per design-media.md):
 *   - patch.alt === undefined  → leave alt unchanged (caller didn't send it)
 *   - patch.alt === "string"   → meaningful description
 *   - patch.alt === ""         → intentionally decorative
 *   - patch.alt === null       → not set (resolver falls back to '')
 *
 * The discriminator is `'alt' in patch` vs `patch.alt`. JS-level distinct
 * meaning of "absent" vs "explicit null". The HTTP layer translates
 * between JSON's `null` (explicit) and field-not-present (absent) so the
 * three-state contract survives the wire.
 */
import type { ContentRoot } from '../content-root.js'
import type { HistoryProvider } from '../history.js'
import { recordWrite, type WrittenItem } from '../history-recorder.js'
import type { AssetManifest } from '../schema/types.js'
import type { StorageProvider } from '../types.js'
import { manifestPath, readManifest, writeManifest } from './manifest.js'
import { AssetStorageError } from './errors.js'

/**
 * Patch shape — every field optional; only present fields are applied.
 * Undefined = "don't change," explicit `null` = "set to null state."
 */
export interface AssetMetadataPatch {
  /** Three-state alt (string | "" | null). Absent in patch = unchanged. */
  alt?: string | null
  /**
   * Focal point in normalized coordinates (0–1). Two-state:
   *   - `{ x, y }` → set it
   *   - `null`     → clear (manifest field becomes absent, falls back
   *                  to center at render time)
   *   - omitted    → unchanged
   */
  focalPoint?: { x: number; y: number } | null
  // Future: tags, title, description, uploadedBy
}

export interface UpdateAssetMetadataInput {
  storage: StorageProvider
  assetsRoot: string
  assetName: string
  patch: AssetMetadataPatch
  history?: HistoryProvider
  contentRoot?: ContentRoot
  author?: string
}

/**
 * Apply a metadata patch to the asset's default manifest. Throws:
 *   - `AssetManifestNotFoundError` — asset doesn't exist
 *   - `AssetStorageError` — manifest write failed
 *
 * Returns the updated manifest so callers can re-summarize for the
 * client without an extra round-trip.
 */
export async function updateAssetMetadata(input: UpdateAssetMetadataInput): Promise<AssetManifest> {
  const current = await readManifest(input.storage, input.assetsRoot, input.assetName)

  // Apply patch: only fields explicitly present in the patch object
  // overwrite the manifest. Each new metadata field adds one
  // `'field' in input.patch` clause here.
  const next: AssetManifest = { ...current }
  if ('alt' in input.patch) {
    next.alt = input.patch.alt ?? null
  }
  if ('focalPoint' in input.patch) {
    const fp = input.patch.focalPoint
    if (fp === null) {
      // Clear → remove the field so the manifest serializes without it.
      delete next.focalPoint
    } else if (fp !== undefined) {
      // Range-check (0–1 inclusive). Invalid input is a programmer
      // error at this layer — the route validator should reject before
      // calling. Defensive throw rather than silent clamp.
      if (fp.x < 0 || fp.x > 1 || fp.y < 0 || fp.y > 1) {
        throw new Error(`Focal point out of range: x=${fp.x}, y=${fp.y} (must be 0–1)`)
      }
      next.focalPoint = { x: fp.x, y: fp.y }
    }
  }

  // Short-circuit no-op patches: identical manifest = identical history
  // entry, but the recorder doesn't dedup entries that produce the same
  // snapshot, so we'd accumulate empty revisions. Skip if nothing changed.
  if (sameManifest(current, next)) return current

  const path = `${input.assetsRoot}/${manifestPath(next.name)}`
  const serialized = `${JSON.stringify(next, null, 2)}\n`

  // Record history BEFORE the write — same pattern as ingest/replace.
  // First-time baseline scan must capture pre-op state.
  if (input.history) {
    if (!input.contentRoot) {
      throw new Error('updateAssetMetadata: history requires contentRoot')
    }
    const items: WrittenItem[] = [{ path, content: serialized }]
    await recordWrite({
      history: input.history,
      contentRoot: input.contentRoot,
      operation: 'save',
      author: input.author,
      items,
      message: `Update metadata for ${input.assetName}`,
    })
  }

  try {
    await writeManifest(input.storage, input.assetsRoot, next)
  } catch (err) {
    throw new AssetStorageError('write', path, err)
  }
  return next
}

function sameManifest(a: AssetManifest, b: AssetManifest): boolean {
  // Cheap deep-equal for the fields a metadata patch can change. Avoids
  // a full JSON.stringify compare for the hot no-op path.
  if (a.alt !== b.alt) return false
  return sameFocalPoint(a.focalPoint, b.focalPoint)
}

function sameFocalPoint(a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.x === b.x && a.y === b.y
}
