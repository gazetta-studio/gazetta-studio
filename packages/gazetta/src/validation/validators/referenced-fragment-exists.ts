import type { ComponentEntry } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'

/**
 * Every `@fragment` reference in components points to an existing fragment.
 *
 * Walks the manifest's components recursively. For each entry of shape
 * `"@name"`, checks `site.fragments` for the name. Flags missing.
 */
export const referencedFragmentExists: Validator = {
  source: 'gazetta',
  name: 'referenced-fragment-exists',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    const issues: Issue[] = []
    const refs = collectFragmentRefs(manifestComponents(manifest), '')
    for (const ref of refs) {
      if (!site.fragments.has(ref.name)) {
        issues.push({
          validator: 'referenced-fragment-exists',
          severity: 'error',
          message: `Fragment "@${ref.name}" referenced but not found in fragments/.`,
          itemPath: scope.item.itemPath,
          contentPath: ref.path,
        })
      }
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
