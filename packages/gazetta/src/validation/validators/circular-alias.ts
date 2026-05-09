/**
 * P3: circular-alias.
 *
 * Per `design-soft-delete.md` Q11 stage matrix: error at background,
 * pre-publish, and cli (no save-delta — by Q3 G1 invariant the flatten
 * cascade prevents chains-by-construction; this validator is defensive
 * for cases where the invariant breaks via direct manifest edits).
 *
 * The check: walk the alias chain `archive A → aliasOf B → ...`. The
 * Q3 G1 invariant says aliases never chain — every archive's aliasOf
 * points at a LIVE item (or a missing one, which P2 surfaces). If the
 * walk hits a chain longer than 1 hop OR loops back to itself, that's
 * a violation of the invariant and gets flagged.
 *
 * # Why error
 *
 * Chains break the alias-aware renderer's assumption (one-hop resolution
 * per design Q3 G1). Cycles cause infinite resolution loops. Both must
 * block publish.
 *
 * # No save-delta stage
 *
 * The rename route's flatten cascade (Cut 6) maintains the invariant
 * on every rename — chains can't be introduced through normal flow.
 * Save-delta gating exists for direct manifest edits OR external git
 * pulls that re-introduce a chain. The background scanner catches
 * those once it next runs; the publish gate blocks at the next ship.
 *
 * # SOLID
 *
 *   - SRP: one check (chain detection); doesn't overlap with P2 or P5.
 *   - DIP: consumes Site; no extra I/O.
 */
import type { Issue, Validator, ValidatorInput } from '../types.js'
import type { FragmentManifest, PageManifest } from '../../types.js'
import type { Site } from '../../site-loader.js'

export const circularAlias: Validator = {
  source: 'gazetta',
  name: 'circular-alias',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'background') return []
    const manifest = scope.manifest

    if (manifest.archived !== true) return []
    if (typeof manifest.aliasOf !== 'string' || manifest.aliasOf.length === 0) return []

    // Walk the chain. Q3 G1 invariant says one hop max — if we make
    // it past 1 hop, that's already a violation. Cap at depth 16 to
    // bound the walk on pathological data.
    const chain = walkAliasChain(scope.item.kind, scope.item.name, site)
    if (!chain.cycle && chain.depth <= 1) return []

    if (chain.cycle) {
      return [
        {
          validator: 'circular-alias',
          severity: 'error',
          message: `Alias cycle: ${chain.path.join(' → ')}. Aliases must not form chains (Q3 G1 invariant).`,
          itemPath: scope.item.itemPath,
        },
      ]
    }

    return [
      {
        validator: 'circular-alias',
        severity: 'error',
        message: `Alias chain: ${chain.path.join(' → ')}. Aliases must point at live items (Q3 G1 invariant — no chaining).`,
        itemPath: scope.item.itemPath,
      },
    ]
  },
}

interface ChainResult {
  /** Path of names visited, starting at the source. */
  path: string[]
  /** Number of hops (path.length - 1). */
  depth: number
  /** True when the walk encountered a name already visited. */
  cycle: boolean
}

function walkAliasChain(kind: 'page' | 'fragment', start: string, site: Site): ChainResult {
  const map = kind === 'page' ? site.pages : site.fragments
  const path: string[] = [start]
  const visited = new Set<string>([start])
  let cur = map.get(start) as (PageManifest | FragmentManifest) | undefined
  const maxDepth = 16

  while (cur && cur.archived === true && typeof cur.aliasOf === 'string' && cur.aliasOf.length > 0) {
    if (path.length - 1 >= maxDepth) break
    const next = cur.aliasOf
    if (visited.has(next)) {
      path.push(next)
      return { path, depth: path.length - 1, cycle: true }
    }
    path.push(next)
    visited.add(next)
    cur = map.get(next)
  }

  return { path, depth: path.length - 1, cycle: false }
}
