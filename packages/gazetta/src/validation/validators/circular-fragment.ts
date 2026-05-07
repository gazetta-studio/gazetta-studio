import type { ComponentEntry, FragmentManifest, PageManifest } from '../../types.js'
import type { Site } from '../../site-loader.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

/**
 * Detect circular fragment references. A fragment that references @A which
 * references @B which references back to the original creates an infinite
 * resolve loop.
 *
 * Save-delta scope: walk fragment refs in the saved manifest, simulating the
 * site state with the saved manifest substituted in. If a cycle is found,
 * report the chain.
 *
 * Only fires for fragments (pages can't be referenced cyclically — pages
 * aren't reachable from each other through @ refs).
 */
export const circularFragment: Validator = {
  source: 'gazetta',
  name: 'circular-fragment',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    if (scope.item.kind !== 'fragment') return [] // only fragments form cycles
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    const fragmentName = scope.item.name
    const fragmentsView = scope.kind === 'save-delta' ? withSubstituted(site, fragmentName, manifest) : site.fragments

    const cycle = findCycle(fragmentName, fragmentsView)
    if (!cycle) return []

    return [
      {
        validator: 'circular-fragment',
        severity: 'error',
        message: `Circular fragment reference: ${cycle.join(' → ')}.`,
        itemPath: scope.item.itemPath,
      },
    ]
  },
}

/**
 * Build a fragments map with `name` substituted by the saved manifest.
 * Other entries pass through. Used for save-delta to evaluate the cycle
 * against the would-be-saved state, not the on-disk state.
 */
function withSubstituted(
  site: Site,
  name: string,
  manifest: PageManifest | FragmentManifest,
): Map<string, FragmentManifest & { dir: string }> {
  const map = new Map(site.fragments)
  const existing = map.get(name)
  // Cast: save-delta scope.after for a fragment IS a fragment manifest by construction.
  const dir = existing?.dir ?? `fragments/${name}`
  map.set(name, { ...(manifest as FragmentManifest), dir })
  return map
}

/**
 * Depth-first search for a cycle starting at `start`. Returns the cycle path
 * (with a closing element to make the loop visible: `a → b → a`) or null.
 */
function findCycle(
  start: string,
  fragments: Map<string, FragmentManifest & { dir: string }>,
): readonly string[] | null {
  const visiting = new Set<string>()
  const path: string[] = []
  return walk(start)

  function walk(name: string): readonly string[] | null {
    if (visiting.has(name)) {
      const idx = path.indexOf(name)
      if (idx >= 0) return [...path.slice(idx), name]
      return [name, name]
    }
    const frag = fragments.get(name)
    if (!frag) return null
    visiting.add(name)
    path.push(name)
    for (const ref of fragmentRefs(frag.components ?? [])) {
      const cycle = walk(ref)
      if (cycle) return cycle
    }
    visiting.delete(name)
    path.pop()
    return null
  }
}

function fragmentRefs(components: readonly ComponentEntry[]): string[] {
  const out: string[] = []
  for (const entry of components) {
    if (typeof entry === 'string' && entry.startsWith('@')) {
      out.push(entry.slice(1))
    } else if (typeof entry === 'object' && entry !== null && entry.components) {
      out.push(...fragmentRefs(entry.components))
    }
  }
  return out
}
