/**
 * P4: archive-not-supported-on-target.
 *
 * Per `design-soft-delete.md` Q11 stage matrix: warn at background,
 * pre-publish, and cli (no save-delta — target capability info isn't
 * authoritative at save time; the publish gate is the right surface).
 *
 * The check: when an archived item exists in the site AND any
 * configured target has `runtime: 'plain-static'` (no worker), warn
 * that redirects won't fire on that target — visitors hitting the
 * old URL get the host's natural 404 instead of a 301 to the alias
 * target (or 410 for pure soft-delete).
 *
 * Per Q10 lock O2 + capability-gap UX: the four-point principle
 * surfaces this concern at boot config validate, author archive
 * modal, validator scanner, AND pre-publish gate. This validator is
 * the "validator scanner" surface.
 *
 * # Why warn
 *
 * It's not a hard error — operators may legitimately accept the
 * limitation (small sites where SEO matters less). The publish gate's
 * strict mode promotes warns to errors per archetype.
 *
 * # No save-delta stage
 *
 * Save-delta runs against one item; target-runtime info is per-site +
 * per-target. The check is naturally site-wide — fits background and
 * pre-publish stages.
 *
 * # SOLID
 *
 *   - SRP: one check (target capability vs. archive presence).
 *   - DIP: consumes the site manifest's target config; doesn't touch
 *     the runtime capability detection logic itself (when
 *     `runtime-capabilities.ts` ships in Cut 9, this validator
 *     consumes the predicate from there).
 */
import type { TargetConfig } from '../../types.js'
import { canServeRedirects } from '../../runtime/runtime-capabilities.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const archiveNotSupportedOnTarget: Validator = {
  source: 'gazetta',
  name: 'archive-not-supported-on-target',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'background') return []
    const manifest = scope.manifest

    // Only fires for archived items.
    if (manifest.archived !== true) return []

    // Consume the shared runtime-capabilities primitive so all four
    // capability-gap surfaces (boot validate, author modal,
    // validator scanner, pre-publish gate) report the same answer.
    const targets = (site.manifest.targets ?? {}) as Record<string, TargetConfig>
    const incompatibleTargets: string[] = []
    for (const [name, target] of Object.entries(targets)) {
      if (!canServeRedirects(target)) incompatibleTargets.push(name)
    }

    if (incompatibleTargets.length === 0) return []

    return [
      {
        validator: 'archive-not-supported-on-target',
        severity: 'warn',
        message: `${scope.item.kind} "${scope.item.name}" is archived. Targets without a worker won't emit 301/410 — visitors will see the host's natural 404 instead. Affected: ${incompatibleTargets.join(', ')}.`,
        itemPath: scope.item.itemPath,
      },
    ]
  },
}
