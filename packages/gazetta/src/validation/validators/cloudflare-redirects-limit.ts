/**
 * cloudflare-redirects-limit: a target with `redirects.format:
 * 'cloudflare'` whose `_redirects` file would pass the 2,000 static rows
 * Cloudflare Pages reads (design-redirects.md "Cloudflare Pages limits",
 * #1149). With a row per language, a four-language target gets there at
 * 500 archived pages with an alias.
 *
 * Warn, at `pre-publish` and `cli` (like archive-not-supported-on-target).
 * At `pre-publish` only the destination being audited is checked: the
 * audit runs once per destination, and a strict one promotes warnings to
 * errors, so another target's file must not block it.
 */
import {
  CLOUDFLARE_REDIRECTS_ROW_LIMIT,
  cloudflareRedirectsLimitMessage,
  cloudflareRedirectsRowCount,
} from '../../redirect-rows.js'
import type { TargetConfig } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const cloudflareRedirectsLimit: Validator = {
  source: 'gazetta',
  name: 'cloudflare-redirects-limit',
  stages: ['pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    const targets = (site.manifest.targets ?? {}) as Record<string, TargetConfig>
    let names: string[]
    if (scope.kind === 'cli') names = Object.keys(targets)
    else if (scope.kind === 'pre-publish' && scope.target !== undefined) names = [scope.target]
    else return []

    const issues: Issue[] = []
    for (const name of names) {
      const rows = cloudflareRedirectsRowCount(site, site.manifest, targets[name])
      if (rows === null || rows <= CLOUDFLARE_REDIRECTS_ROW_LIMIT) continue
      issues.push({
        validator: 'cloudflare-redirects-limit',
        severity: 'warn',
        message: cloudflareRedirectsLimitMessage(name, rows),
        itemPath: `site.config.ts:targets.${name}.redirects`,
        subject: 'row-limit',
      })
    }
    return issues
  },
}
