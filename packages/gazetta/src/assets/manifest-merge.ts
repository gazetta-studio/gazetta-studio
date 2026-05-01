/**
 * Manifest field-merge primitives. Pure functions; no I/O.
 *
 * Two operations:
 *   - `applyLocaleOverrides` — shallow spread of one override on top of a
 *     base manifest. The override's non-undefined fields win; everything
 *     else falls through to the base.
 *   - `foldLocaleChain` — multi-overlay fold: read each chain entry and
 *     spread it on the previous, most-specific-LAST so most-specific
 *     wins per field.
 *
 * # Why a separate module
 *
 * The merge is the one piece of logic shared between embedded and
 * downloadable kind resolvers (per Q3 lock). Font resolver does NOT
 * use override-merge — it composes a variant union, structurally
 * different. So the merge primitive lives separately and the kinds
 * that share semantics compose it; the one that doesn't, doesn't.
 *
 * # Shallow vs deep
 *
 * The merge is SHALLOW. `focalPoint`, `variants`, `width`, `height` are
 * atomic values from the override's perspective — partial focal-point
 * overrides aren't a concept. If a locale variant carries `focalPoint`,
 * its full {x, y} pair replaces the default's; you don't mix x from one
 * with y from another.
 *
 * # Why use spread of `Partial<M>` instead of typed `LocaleOverrideManifest`
 *
 * Generic over manifest type so the same primitive can serve embedded
 * and downloadable (and any future kind that wants override-wins
 * semantics) without re-implementing per kind.
 */

/**
 * Spread `override`'s non-undefined fields onto `base`. Returns a new
 * object — `base` is not mutated.
 *
 * Fields that are `undefined` in `override` do NOT shadow `base`'s value.
 * That's the whole point: a locale manifest with only `alt` set should
 * keep the default's everything-else.
 *
 * `null` is treated as a value, not "absent". `alt: null` on the override
 * explicitly clears the default's alt — useful for "this locale's image
 * is decorative even though the default has alt text."
 */
export function applyLocaleOverrides<M extends object>(base: M, override: Partial<M> | null): M {
  if (override === null) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

/**
 * Fold a chain of overrides onto a base. Chain order is
 * most-specific-LAST so the final fold step replaces fields from
 * less-specific entries.
 *
 * Example for active `pt-BR` with fallback `pt`:
 *
 *   chain = [pt-manifest, pt-BR-manifest]   // least-specific FIRST
 *   foldLocaleChain(default, chain)
 *
 * Step 1: apply pt overrides onto default → pt-effective
 * Step 2: apply pt-BR overrides onto pt-effective → pt-BR-effective
 *
 * Most-specific (pt-BR) wins per field. Entries that are `null` (locale
 * manifest didn't exist) are skipped — same effect as no overrides.
 *
 * Caller responsibility: order the chain correctly. Most-specific LAST.
 */
export function foldLocaleChain<M extends object>(base: M, chain: readonly (Partial<M> | null)[]): M {
  let current = base
  for (const overrides of chain) {
    current = applyLocaleOverrides(current, overrides)
  }
  return current
}
