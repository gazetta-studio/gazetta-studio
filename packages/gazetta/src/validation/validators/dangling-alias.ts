/**
 * P2: dangling-alias.
 *
 * Per `design-soft-delete.md` Q11 stage matrix: error at save-delta,
 * background, pre-publish, and cli. Severity is always `error` —
 * dangling aliases break the alias-aware renderer (the redirect
 * target doesn't exist).
 *
 * The check: when an item is archived with `aliasOf: X`, validate
 * that an item named `X` exists in `site.pages` (for archived pages)
 * or `site.fragments` (for archived fragments).
 *
 * Symmetric to `referenced-fragment-exists` — both check that a
 * reference has a target. The difference: this validator checks the
 * archive's own aliasOf field, not the components list.
 *
 * # Why error
 *
 * An archived page with `aliasOf: 'missing'` would render `301 →
 * /missing`, which then 404s. An archived fragment aliasing
 * `@missing` would fail to compose at render time. Both are broken
 * states; the publish gate must block.
 *
 * # Save-delta path
 *
 * When the saved manifest is itself archived with aliasOf, validate.
 * When the saved manifest is live (not archived), no-op — only
 * archives can be dangling.
 *
 * # SOLID
 *
 *   - SRP: one check; doesn't overlap with circular-alias (P3) or
 *     aliasOf-points-to-archived (P5).
 *   - DIP: consumes Site; no extra I/O.
 */
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const danglingAlias: Validator = {
  source: 'gazetta',
  name: 'dangling-alias',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    if (manifest.archived !== true) return []
    if (typeof manifest.aliasOf !== 'string' || manifest.aliasOf.length === 0) return []

    const targetName = manifest.aliasOf
    const targetMap = scope.item.kind === 'page' ? site.pages : site.fragments
    if (targetMap.has(targetName)) return []

    return [
      {
        validator: 'dangling-alias',
        severity: 'error',
        message: `Aliased ${scope.item.kind} "${scope.item.name}" points to "${targetName}" which does not exist. The 301 redirect target is missing.`,
        itemPath: scope.item.itemPath,
      },
    ]
  },
}
