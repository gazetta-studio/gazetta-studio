import type { ComponentEntry } from '../../types.js'
import type { Site } from '../../site-loader.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'

/**
 * A fragment defined in `fragments/` but not referenced by any page or other
 * fragment is unused. Surfaces as `info` (not `warn`) — operators legitimately
 * keep work-in-progress fragments around; this is a hint, not a defect.
 *
 * Background scope only: requires walking the entire site to know whether
 * any item references the fragment in question. Per-item save-delta can't
 * tell — adding the fragment is fine; removing the only ref is what makes
 * it orphaned.
 *
 * One issue per orphaned fragment, surfaced on the fragment itself
 * (`itemPath: fragments/{name}/fragment.json`).
 */
export const unusedFragment: Validator = {
  source: 'gazetta',
  name: 'unused-fragment',
  stages: ['background', 'cli'] as const,

  defaultSeverity() {
    return 'info'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'background' && scope.kind !== 'cli') return []
    // Background scope is per-item; only emit issues from the fragment itself,
    // so the issue lands on the right tree node. CLI scope is site-wide and
    // emits all orphans at once.
    if (scope.kind === 'background' && scope.item.kind !== 'fragment') return []

    const referenced = collectReferencedFragments(site)

    if (scope.kind === 'background') {
      const fragName = scope.item.name
      if (referenced.has(fragName)) return []
      return [
        {
          validator: 'unused-fragment',
          severity: 'info',
          message: `Fragment "@${fragName}" is defined but no page or fragment references it.`,
          itemPath: scope.item.itemPath,
        },
      ]
    }

    // CLI: enumerate every orphan
    const issues: Issue[] = []
    for (const [name, frag] of site.fragments) {
      if (referenced.has(name)) continue
      issues.push({
        validator: 'unused-fragment',
        severity: 'info',
        message: `Fragment "@${name}" is defined but no page or fragment references it.`,
        itemPath: `${frag.dir}/fragment.json`,
      })
    }
    return issues
  },
}

/**
 * Walk every page and every fragment, collecting the set of fragment names
 * referenced via `@name` in their components tree (recursively). The result
 * is the "live" set; anything in `site.fragments` not in this set is orphaned.
 */
function collectReferencedFragments(site: Site): Set<string> {
  const referenced = new Set<string>()
  for (const page of site.pages.values()) {
    walkFragmentRefs(manifestComponents(page), referenced)
  }
  for (const frag of site.fragments.values()) {
    walkFragmentRefs(manifestComponents(frag), referenced)
  }
  return referenced
}

function walkFragmentRefs(components: readonly ComponentEntry[], out: Set<string>): void {
  for (const entry of components) {
    if (typeof entry === 'string' && entry.startsWith('@')) {
      out.add(entry.slice(1))
      continue
    }
    if (typeof entry === 'object' && entry !== null && entry.components) {
      walkFragmentRefs(entry.components, out)
    }
  }
}
