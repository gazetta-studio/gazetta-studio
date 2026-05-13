/**
 * deploy-target-type-supported (Cut 2 of #203).
 *
 * Per Q5 of the deploy design pass: adapter declares
 * `supports: readonly TargetType[]`; the validator flags when a
 * target's `type` isn't in the adapter's supported set.
 *
 * # Stage
 *
 * `cli` only. Pre-publish enforcement is deferred — the validator
 * framework's pre-publish scope (`SavedItem[]`) doesn't carry target
 * context today. The publish route enforces target compatibility via
 * a separate target-capability inspection (Cut 3+); not the
 * validator framework.
 *
 * # Severity
 *
 * Error. Incompatible adapter/target combinations would silently
 * fail at deploy time; surfacing as a validation error at
 * `gazetta validate` time blocks that.
 *
 * # SOLID
 *
 *   - SRP: one rule — adapter `supports` vs `target.type`.
 *   - DIP: depends on the `DeployAdapter` interface, not on any
 *     concrete adapter.
 *   - OCP: new adapters declare their `supports` set; this
 *     validator unchanged.
 */
import type { TargetConfig } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const deployTargetTypeSupported: Validator = {
  source: 'gazetta',
  name: 'deploy-target-type-supported',
  stages: ['cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'cli') return []

    const targets = (site.manifest.targets ?? {}) as Record<string, TargetConfig>
    const issues: Issue[] = []

    for (const [name, target] of Object.entries(targets)) {
      const deploy = target.deploy
      if (!deploy) continue // no adapter → no compatibility to check
      const targetType = target.type ?? 'static' // default per TargetConfig
      if (deploy.supports.includes(targetType)) continue

      issues.push({
        validator: 'deploy-target-type-supported',
        severity: 'error',
        message:
          `Target "${name}" has type: "${targetType}" but deploy adapter "${deploy.name}" supports only [${deploy.supports.map(s => `"${s}"`).join(', ')}]. ` +
          `Either switch to a compatible adapter or change target type.`,
        itemPath: `site.config.ts:targets.${name}.deploy`,
      })
    }

    return issues
  },
}
