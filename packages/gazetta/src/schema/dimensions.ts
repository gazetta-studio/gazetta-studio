/**
 * Asset override dimensions — the axes along which an asset's bytes,
 * variants, and metadata can vary from its default.
 *
 * v1 ships two first-class dimensions:
 *   - `locale` — content-level (e.g. text baked into image varies by language)
 *   - `theme`  — presentation-level (e.g. logo with light/dark variants)
 *
 * Both are peer dimensions in the abstract model. Each asset can opt into
 * any combination — a logo might have `(en, dark)`, `(fr, dark)`, `(de, dark)`
 * variants but no light-mode variants because the default works for light.
 *
 * # Why a closed dimension set
 *
 * A user-defined dimension model (arbitrary axes per site) was rejected
 * during foundation design. 90% of value is locale + theme; arbitrary
 * dimensions complicate the picker UI, fallback chain semantics, and
 * filename composition with no concrete demand. Adding a third dimension
 * later means extending this union and `DIMENSION_ORDER` — mechanical.
 *
 * # Filename composition
 *
 * `DIMENSION_ORDER` fixes the order in which dimensions appear in
 * filenames. `{name}.asset.{locale}.{theme}.json` (locale before theme).
 * Changing the order would re-key every existing locale-only manifest, so
 * it's locked: locale always first.
 *
 * # Selector semantics
 *
 * A `Selector` represents a specific combination of dimension values.
 * `null` selector = "default-default" (no overrides; the canonical asset).
 * Empty `Selector` Map is structurally invalid — callers must use `null`
 * to express "no dimensions selected." Validators enforce.
 */

/** The set of override dimensions an asset can vary along. */
export type DimensionName = 'locale' | 'theme'

/**
 * Order in which dimensions appear in composed filenames. Locked: locale
 * before theme. Adding a new dimension extends this constant; existing
 * filenames stay valid because they have no value for the new dimension.
 */
export const DIMENSION_ORDER: readonly DimensionName[] = ['locale', 'theme']

/**
 * A specific combination of dimension values that addresses one asset
 * variant (or the default, when null).
 *
 * Examples:
 *   `null` — the default asset
 *   `Map { 'locale' → 'fr' }` — French (default theme)
 *   `Map { 'locale' → 'fr', 'theme' → 'dark' }` — French + dark
 *   `Map { 'theme' → 'dark' }` — dark (default locale)
 */
export type Selector = ReadonlyMap<DimensionName, string>

/** True when `selector` has at least one dimension set. */
export function isNonEmptySelector(selector: Selector | null): selector is Selector {
  return selector !== null && selector.size > 0
}

/**
 * Build a Selector from individual dimension values, omitting unset ones.
 * Returns `null` when all dimensions are absent — semantically equivalent
 * to "the default asset."
 */
export function buildSelector(values: Partial<Record<DimensionName, string>>): Selector | null {
  const map = new Map<DimensionName, string>()
  for (const dim of DIMENSION_ORDER) {
    const v = values[dim]
    if (v !== undefined) map.set(dim, v)
  }
  return map.size > 0 ? map : null
}

/**
 * Compose the path-suffix portion of a filename for a selector. Walks
 * `DIMENSION_ORDER` so the order is deterministic regardless of insertion
 * order in the underlying Map.
 *
 *   null                           → ''           (no suffix)
 *   { locale: 'fr' }               → '.fr'
 *   { theme: 'dark' }              → '.dark'
 *   { locale: 'fr', theme: 'dark'} → '.fr.dark'
 */
export function selectorSuffix(selector: Selector | null): string {
  if (!selector) return ''
  const parts: string[] = []
  for (const dim of DIMENSION_ORDER) {
    const v = selector.get(dim)
    if (v !== undefined) parts.push(v)
  }
  return parts.length > 0 ? `.${parts.join('.')}` : ''
}

/**
 * Two selectors are equivalent when they have the same dimensions set
 * to the same values, ignoring iteration order.
 */
export function selectorsEqual(a: Selector | null, b: Selector | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false
  }
  return true
}
