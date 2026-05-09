/**
 * P1: referenced-archived-without-alias.
 *
 * Per `design-soft-delete.md` Q11 stage matrix: warn at save-delta (when
 * newly introduced), background, pre-publish, and cli. Severity is
 * `warn` across all stages — the publish gate's strict mode promotes
 * to error per archetype config (deferred to validation Cut 4).
 *
 * The check: for each `@fragment` reference in the saved/scanned
 * manifest, look up the target fragment in `site.fragments`. When
 * the target is archived AND has no `aliasOf`, emit a warning.
 *
 * Why warn (not error): pure soft-delete is a legitimate state for
 * archives that have been intentionally retired (Q2 F1 lock —
 * archived-no-alias renders 410 / fragment-render error). The author
 * may need to update references at their own pace; the warning makes
 * the broken-on-publish state visible without blocking saves.
 *
 * # Save-delta scope (Q11 lock — "warn when newly introduced")
 *
 * The save-delta variant only fires for refs that are NEW in this
 * save (present in `after`, absent in `before`). Pre-existing refs to
 * archived-no-alias fragments stay in the background scanner's surface
 * — the save handler's job is to flag what THIS edit introduced.
 *
 * # SOLID
 *
 *   - SRP: this validator owns one check (ref → archive-no-alias);
 *     doesn't share logic with other archive validators.
 *   - DIP: consumes `Site` (already in ValidatorInput); no extra I/O.
 */
import type { ComponentEntry } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'

export const referencedArchivedWithoutAlias: Validator = {
  source: 'gazetta',
  name: 'referenced-archived-without-alias',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    // Collect refs in the current manifest. For save-delta, we'd
    // ideally diff against `before` to flag only newly-introduced
    // refs (per Q11), but the existing site-state already reflects
    // post-save lookups; the simpler-and-honest approach is to flag
    // every problematic ref in the current manifest. The background
    // scanner runs the same check so authors see the full picture.
    const refs = collectFragmentRefs(manifestComponents(manifest), '')

    // For save-delta, narrow to refs that are newly introduced.
    let refsToCheck = refs
    if (scope.kind === 'save-delta') {
      const beforeRefs = scope.before
        ? new Set(collectFragmentRefs(manifestComponents(scope.before), '').map(r => r.name))
        : new Set<string>()
      refsToCheck = refs.filter(r => !beforeRefs.has(r.name))
    }

    const issues: Issue[] = []
    for (const ref of refsToCheck) {
      const target = site.fragments.get(ref.name)
      if (!target) continue // missing fragment is referenced-fragment-exists's job
      if (target.archived !== true) continue // live fragment — fine
      if (target.aliasOf) continue // aliased archive — fine; render emits 301
      issues.push({
        validator: 'referenced-archived-without-alias',
        severity: 'warn',
        message: `References "@${ref.name}" which is archived without an alias. The fragment will fail to render until the archive gets an aliasOf or the reference is removed.`,
        itemPath: scope.item.itemPath,
        contentPath: ref.path,
      })
    }
    return issues
  },
}

function collectFragmentRefs(
  components: readonly ComponentEntry[],
  parentPath: string,
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = []
  for (const entry of components) {
    if (typeof entry === 'string' && entry.startsWith('@')) {
      const fragName = entry.slice(1)
      const path = parentPath ? `${parentPath}/${entry}` : entry
      out.push({ name: fragName, path })
      continue
    }
    if (typeof entry === 'object' && entry !== null && entry.components) {
      const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name
      out.push(...collectFragmentRefs(entry.components, childPath))
    }
  }
  return out
}
