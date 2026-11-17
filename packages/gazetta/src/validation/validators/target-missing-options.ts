/**
 * target-missing-options (#1185). A storage or deploy factory called without
 * a required option (`process.env.R2_ACCESS_KEY_ID!` with the variable unset)
 * still returns, and fails when its target is used. This lists each missing
 * option, so a teammate without the production keys sees which target needs
 * which variable. A warning: `gazetta validate` itself uses no target.
 */
import { missingOptionsOf } from '../../providers/missing-options.js'
import type { TargetConfig } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const targetMissingOptions: Validator = {
  source: 'gazetta',
  name: 'target-missing-options',
  stages: ['cli'] as const,

  defaultSeverity() {
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    if (input.scope.kind !== 'cli') return []
    const targets = (input.site.manifest.targets ?? {}) as Record<string, TargetConfig>
    const issues: Issue[] = []
    for (const [name, target] of Object.entries(targets)) {
      for (const [field, value] of [
        ['storage', target.storage],
        ['deploy', target.deploy],
      ] as const) {
        for (const missing of missingOptionsOf(value)) {
          issues.push({
            validator: 'target-missing-options',
            severity: 'warn',
            message: `\`${name}\`: ${missing.message}`,
            itemPath: `site.config.ts:targets.${name}`,
            subject: `${field}.${missing.option}`,
          })
        }
      }
    }
    return issues
  },
}
