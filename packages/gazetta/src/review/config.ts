/**
 * Review-workflow config resolver — composes site-level + per-target
 * `reviewWorkflow` blocks into a single fully-defaulted
 * `ReviewWorkflowConfig`, per `design-review-workflow.md`
 * "Configuration" + Cut 1 acceptance ("target without `reviewWorkflow`
 * inherits the site-level config").
 *
 * Per-field chain (target wins, site falls through, hardcoded defaults
 * supply absent fields):
 *
 *   - `enabled`:           target ?? site ?? false
 *   - `requiredApprovers`: target ?? site ?? 1
 *   - `allowSelfApproval`: target ?? site ?? true
 *   - `invalidateOnSave`:  target ?? site ?? 'content-diff'
 *
 * Returns `null` when neither site nor target carries a
 * `reviewWorkflow` block — downstream cuts (state machine, save
 * handler, audit) read `null` as "review off, fall back to today's
 * direct-write semantics."
 *
 * Pure function — no I/O, no env reads, no SDK construction. The same
 * shape as `resolveAltConfig` (`alt/config.ts`): inheritance computed
 * over data, never over registration.
 *
 * # SOLID
 *
 *   - SRP: this module owns "merge review-workflow config layers into
 *     one resolved value." Schema validation lives in `config/schemas.ts`.
 *   - DIP: downstream cuts depend on `ReviewWorkflowConfig` (the data
 *     shape), never on raw `SiteManifest`/`TargetConfig` field reads.
 *   - LSP: resolver is total — every input shape returns either a
 *     fully-defaulted `ReviewWorkflowConfig` or `null`.
 */
import type { ReviewWorkflowConfig, SiteManifest, TargetConfig } from '../types.js'

const DEFAULT_ENABLED = false
const DEFAULT_REQUIRED_APPROVERS = 1
const DEFAULT_ALLOW_SELF_APPROVAL = true
const DEFAULT_INVALIDATE_ON_SAVE = 'content-diff' as const

/**
 * Resolve the effective review-workflow config for a target. Returns
 * `null` when neither site nor target carries a `reviewWorkflow`
 * block — the contract that signals "review is off for this target."
 */
export function resolveReviewWorkflow(
  site: Pick<SiteManifest, 'reviewWorkflow'>,
  target: Pick<TargetConfig, 'reviewWorkflow'>,
): Required<ReviewWorkflowConfig> | null {
  const siteRW = site.reviewWorkflow
  const targetRW = target.reviewWorkflow
  if (!siteRW && !targetRW) return null

  return {
    enabled: targetRW?.enabled ?? siteRW?.enabled ?? DEFAULT_ENABLED,
    requiredApprovers: targetRW?.requiredApprovers ?? siteRW?.requiredApprovers ?? DEFAULT_REQUIRED_APPROVERS,
    allowSelfApproval: targetRW?.allowSelfApproval ?? siteRW?.allowSelfApproval ?? DEFAULT_ALLOW_SELF_APPROVAL,
    invalidateOnSave: targetRW?.invalidateOnSave ?? siteRW?.invalidateOnSave ?? DEFAULT_INVALIDATE_ON_SAVE,
  }
}
