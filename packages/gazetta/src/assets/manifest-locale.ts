/**
 * Locale-variant manifest I/O + validation, dispatched by asset kind.
 *
 * Three kinds, three locale-variant shapes:
 *   - embedded → `LocaleOverrideManifest` (override-merge per Q3 lock)
 *   - downloadable → `LocaleOverrideManifest` (same shape as embedded)
 *   - font → `FontLocaleAdditiveManifest` (additive variant union, NOT
 *     override; per Q3 lock fonts compose differently)
 *
 * # The interface
 *
 * `LocaleManifestVariant<T>` packages "validate + read" for one kind's
 * locale-variant shape. Three implementations (one per kind), one
 * dispatch table. Adding a new kind = new implementation + table entry,
 * no changes to existing kinds.
 *
 * # Why locale variants are optional
 *
 * Default manifests are required (no default = asset doesn't exist);
 * locale variants are optional. Reads return `null` when the file is
 * missing — same shape as "no override for this locale." Throwing on
 * missing would force every walker to wrap in try/catch when "absent"
 * is the common case.
 *
 * # Why a separate module from manifest-default.ts
 *
 * Default and locale shapes are genuinely distinct (locale-override has
 * optional byte fields; locale-additive-font has font-specific fields).
 * Separate modules let each evolve independently. The dispatch table
 * (`localeManifestVariants`) is the only place a caller bridges them —
 * keying by `AssetKind` keeps the bridge mechanical.
 */
import type { StorageProvider } from '../types.js'
import type { Selector } from '../schema/dimensions.js'
import type { AssetKind, AssetVariant, FontLocaleAdditiveManifest, LocaleOverrideManifest } from '../schema/types.js'
import { AssetManifestCorruptError, AssetStorageError } from './errors.js'
import { manifestPath } from './manifest.js'

/**
 * Variant of locale-manifest I/O for one asset kind. Three concrete
 * implementations; the dispatch table picks based on the default
 * manifest's `kind` (which is read separately, before any locale
 * variant lookup).
 */
export interface LocaleManifestVariant<T> {
  /** Type guard for parsed JSON. Returns false on shape mismatch. */
  validate(parsed: unknown): parsed is T
  /**
   * Read + parse + validate. Returns `null` when the file doesn't
   * exist (the common case). Throws `AssetManifestCorruptError` on
   * shape mismatch, `AssetStorageError` on I/O failure.
   */
  read(storage: StorageProvider, assetsRoot: string, assetName: string, selector: Selector): Promise<T | null>
}

// ---------- Embedded locale-override variant ----------

const embeddedVariant: LocaleManifestVariant<LocaleOverrideManifest> = {
  validate(parsed): parsed is LocaleOverrideManifest {
    return validateLocaleOverride(parsed)
  },
  async read(storage, assetsRoot, assetName, selector) {
    return readLocaleOverride(storage, assetsRoot, assetName, selector)
  },
}

// ---------- Downloadable locale-override variant ----------

// Today's downloadable shape matches embedded's locale-override shape
// exactly — both share `LocaleOverrideManifest`. They diverge structurally
// only when downloadable gains its own fields (`title`, `description`)
// in step 17. The validator gains those checks then; today the same
// `validateLocaleOverride` covers both, with the kind-specific switch
// living in this dispatch.
const downloadableVariant: LocaleManifestVariant<LocaleOverrideManifest> = {
  validate(parsed): parsed is LocaleOverrideManifest {
    return validateLocaleOverride(parsed)
  },
  async read(storage, assetsRoot, assetName, selector) {
    return readLocaleOverride(storage, assetsRoot, assetName, selector)
  },
}

// ---------- Font locale-additive variant ----------

const fontVariant: LocaleManifestVariant<FontLocaleAdditiveManifest> = {
  validate(parsed): parsed is FontLocaleAdditiveManifest {
    return validateFontLocaleAdditive(parsed)
  },
  async read(storage, assetsRoot, assetName, selector) {
    return readFontLocaleAdditive(storage, assetsRoot, assetName, selector)
  },
}

// ---------- Dispatch table ----------

/**
 * Map kind → locale variant. Walker reads the default first to discover
 * `kind`, then looks up the right variant here. Type narrows via the
 * indexed access in `localeManifestVariantFor`.
 */
const variantsByKind = {
  embedded: embeddedVariant,
  downloadable: downloadableVariant,
  font: fontVariant,
} as const

/**
 * Get the locale-manifest variant for a given asset kind. Type
 * narrows the return so callers see the right manifest shape.
 */
export function localeManifestVariantFor(kind: 'embedded'): LocaleManifestVariant<LocaleOverrideManifest>
export function localeManifestVariantFor(kind: 'downloadable'): LocaleManifestVariant<LocaleOverrideManifest>
export function localeManifestVariantFor(kind: 'font'): LocaleManifestVariant<FontLocaleAdditiveManifest>
export function localeManifestVariantFor(
  kind: AssetKind,
): LocaleManifestVariant<LocaleOverrideManifest> | LocaleManifestVariant<FontLocaleAdditiveManifest>
export function localeManifestVariantFor(
  kind: AssetKind,
): LocaleManifestVariant<LocaleOverrideManifest> | LocaleManifestVariant<FontLocaleAdditiveManifest> {
  return variantsByKind[kind]
}

// ---------- Shared read helper for embedded/downloadable ----------

async function readLocaleOverride(
  storage: StorageProvider,
  assetsRoot: string,
  assetName: string,
  selector: Selector,
): Promise<LocaleOverrideManifest | null> {
  const path = `${assetsRoot}/${manifestPath(assetName, selector)}`

  const exists = await storage.exists(path).catch(err => {
    throw new AssetStorageError('stat', path, err)
  })
  if (!exists) return null

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

  if (!validateLocaleOverride(parsed)) {
    throw new AssetManifestCorruptError(path, new Error('locale-override manifest shape mismatch'))
  }
  return parsed
}

async function readFontLocaleAdditive(
  storage: StorageProvider,
  assetsRoot: string,
  assetName: string,
  selector: Selector,
): Promise<FontLocaleAdditiveManifest | null> {
  const path = `${assetsRoot}/${manifestPath(assetName, selector)}`

  const exists = await storage.exists(path).catch(err => {
    throw new AssetStorageError('stat', path, err)
  })
  if (!exists) return null

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

  if (!validateFontLocaleAdditive(parsed)) {
    throw new AssetManifestCorruptError(path, new Error('font-locale-additive manifest shape mismatch'))
  }
  return parsed
}

// ---------- Validators ----------

/**
 * Validate a locale-override manifest. Two valid shapes (per the
 * discriminated union in schema/types.ts):
 *
 *   1. Metadata-only override — no `hash`. All byte-describing fields
 *      must be absent. Optional metadata fields validate per their type.
 *   2. Bytes override — `hash` set. `size`, `mime`, `width`, `height`,
 *      `variants` MUST all be present (byte-presence-coupled).
 */
function validateLocaleOverride(candidate: unknown): candidate is LocaleOverrideManifest {
  if (!candidate || typeof candidate !== 'object') return false
  const m = candidate as Record<string, unknown>

  // Identity fields (always present)
  if (m.version !== 1) return false
  if (typeof m.name !== 'string') return false

  // Byte-presence coupling: hash present ⇒ all bytes-describing fields present
  const hasHash = m.hash !== undefined
  if (hasHash) {
    if (typeof m.hash !== 'string') return false
    if (typeof m.size !== 'number') return false
    if (typeof m.mime !== 'string') return false
    if (m.width !== null && typeof m.width !== 'number') return false
    if (m.height !== null && typeof m.height !== 'number') return false
    if (!Array.isArray(m.variants)) return false
    if (!m.variants.every(isAssetVariant)) return false
  } else {
    // Metadata-only: byte-describing fields must all be absent
    if (m.size !== undefined) return false
    if (m.mime !== undefined) return false
    if (m.width !== undefined) return false
    if (m.height !== undefined) return false
    if (m.variants !== undefined) return false
  }

  // Optional metadata overrides (shared by metadata-only and bytes-override)
  if (m.alt !== undefined && m.alt !== null && typeof m.alt !== 'string') return false
  if (m.focalPoint !== undefined && !isFocalPoint(m.focalPoint)) return false
  if (m.title !== undefined && typeof m.title !== 'string') return false
  if (m.description !== undefined && typeof m.description !== 'string') return false

  return true
}

/**
 * Validate a font locale-additive manifest. Fonts always have bytes
 * (a font with no bytes is meaningless) AND font-specific fields.
 */
function validateFontLocaleAdditive(candidate: unknown): candidate is FontLocaleAdditiveManifest {
  if (!candidate || typeof candidate !== 'object') return false
  const m = candidate as Record<string, unknown>

  if (m.version !== 1) return false
  if (typeof m.name !== 'string') return false

  // Bytes are mandatory for fonts
  if (typeof m.hash !== 'string') return false
  if (typeof m.size !== 'number') return false
  if (typeof m.mime !== 'string') return false

  // Font-specific fields
  if (m.format !== 'woff2' && m.format !== 'woff' && m.format !== 'ttf' && m.format !== 'otf') return false
  if (m.weight !== 'variable' && typeof m.weight !== 'number') return false
  if (m.style !== 'normal' && m.style !== 'italic') return false
  if (m.unicodeRange !== null && typeof m.unicodeRange !== 'string') return false

  return true
}

function isAssetVariant(candidate: unknown): candidate is AssetVariant {
  if (!candidate || typeof candidate !== 'object') return false
  const v = candidate as Record<string, unknown>
  return typeof v.width === 'number' && typeof v.path === 'string' && typeof v.size === 'number'
}

function isFocalPoint(candidate: unknown): candidate is { x: number; y: number } {
  if (!candidate || typeof candidate !== 'object') return false
  const f = candidate as Record<string, unknown>
  return typeof f.x === 'number' && typeof f.y === 'number'
}
