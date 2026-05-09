/**
 * P5: aliasOf-points-to-archived.
 *
 * Per `design-soft-delete.md` Q11 stage matrix: warn at background,
 * pre-publish, and cli. Defensive against the Q3 G1 invariant being
 * violated through direct manifest edits or external git pulls.
 *
 * The check: when an archive's `aliasOf` target IS itself archived,
 * warn. Per Q3 G1 lock, archives' aliasOf must point at LIVE items.
 * If it points at another archive, the renderer's one-hop resolution
 * lands on an archived item → which then needs another hop → chain.
 *
 * # Difference from P3 (circular-alias)
 *
 *   - P3 detects CYCLES (A → B → A) and chains longer than 1 hop
 *   - P5 detects "alias target is archived" specifically (one hop is
 *     enough; the target being archived violates Q3 G1 even without
 *     a chain)
 *
 * P3 catches the chain pathology; P5 catches the simpler "you aliased
 * to an archive, but archives shouldn't be alias targets" mistake.
 *
 * # Why warn (not error)
 *
 * Per design Q11. The render-time behavior depends on whether the
 * archived target itself has an aliasOf — if it does, the renderer
 * follows the chain (which violates Q3 G1, surfacing as P3 error).
 * If it doesn't (pure soft-delete), the renderer emits 410. Either
 * way, the situation is recoverable — author rewrites the alias to
 * a live target.
 *
 * # SOLID
 *
 *   - SRP: one check (aliasOf points at archive); doesn't overlap
 *     with P2 (target missing) or P3 (chain).
 *   - DIP: consumes Site; no extra I/O.
 */
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const aliasOfPointsToArchived: Validator = {
  source: 'gazetta',
  name: 'aliasOf-points-to-archived',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'background') return []
    const manifest = scope.manifest

    if (manifest.archived !== true) return []
    if (typeof manifest.aliasOf !== 'string' || manifest.aliasOf.length === 0) return []

    const targetName = manifest.aliasOf
    const targetMap = scope.item.kind === 'page' ? site.pages : site.fragments
    const target = targetMap.get(targetName)
    if (!target) return [] // P2 (dangling-alias) handles missing
    if (target.archived !== true) return [] // target is live — fine

    return [
      {
        validator: 'aliasOf-points-to-archived',
        severity: 'warn',
        message: `${scope.item.kind} "${scope.item.name}" aliases "${targetName}", which is itself archived. Archives' aliasOf must point at live items (Q3 G1 invariant).`,
        itemPath: scope.item.itemPath,
      },
    ]
  },
}
