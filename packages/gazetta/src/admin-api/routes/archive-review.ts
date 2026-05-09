/**
 * Cut 14 — review-workflow integration for archive lifecycle.
 *
 * Per `design-soft-delete.md` Q9 (N-A.2 + N-B.1):
 *   - Archive on `pending-review` → auto-withdraw fires first; then archive.
 *     Two audit events emitted: `review-withdraw` with
 *     `metadata.autoWithdrawn: true`, then `archive`.
 *   - Archive on `approved` → approved state discarded; no synthetic
 *     withdraw event (the prior state is recorded in archive metadata
 *     as `priorReviewState: 'approved'`).
 *   - Archive on `draft` → no review-related side effects.
 *   - Restore (unarchive) → always to `draft`, regardless of prior state.
 *     Author re-submits if review needed. Auto-restoring to `approved`
 *     would let stale content ship without re-validation.
 *
 * # Forward-compat with review-workflow's Tier-3 timeline
 *
 * The review-workflow foundation hasn't shipped. Today's manifests
 * never carry a `reviewState` field; this module's logic is therefore
 * a no-op on every current production save. When review-workflow Cut 6
 * lands and starts writing `reviewState` to manifests, this module
 * activates without code changes.
 *
 * Gate is data-driven (`manifest.reviewState` presence), not config-
 * driven (`reviewWorkflow.enabled` flag). The plan's wording around a
 * config flag is one valid implementation; data-driven is honest:
 * "if this item has review state, handle it; else no-op." When
 * review-workflow ships its config field, no flag-check refactor is
 * needed.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the archive ↔ review-state interaction.
 *     `archive.ts`'s `handleArchive` calls one function (`prepareForArchive`)
 *     and consumes its returned audit events; doesn't replicate state-
 *     machine knowledge.
 *   - DIP: `handleArchive` depends on the helper's typed return shape,
 *     not on review-state field names baked into the route handler.
 *   - OCP: when review-workflow ships its full state machine
 *     (additional states, transitions like `pending-publish`), this
 *     helper extends with new branches; archive route untouched.
 */
import type { ComponentManifest } from '../../types.js'
import type { RecordEventInput } from '../../audit/context.js'

/**
 * Read `reviewState` from a manifest without committing the field
 * to `ComponentManifest`'s public type. The review-workflow
 * foundation will lock the field's shape when it ships; until then,
 * callers narrow at the read site.
 *
 * Returns the string state when present; `undefined` for live
 * manifests today (every current production manifest).
 */
function readReviewState(manifest: ComponentManifest): string | undefined {
  const m = manifest as ComponentManifest & { reviewState?: unknown }
  return typeof m.reviewState === 'string' ? m.reviewState : undefined
}

/**
 * Build the synthetic `review-withdraw` audit event emitted when
 * archive auto-withdraws a `pending-review` submission. Per
 * `design-soft-delete.md` Q9 audit shape lock.
 *
 * Returns `null` when the prior state isn't `pending-review` —
 * other states (draft, approved) don't emit a synthetic withdraw.
 * Approved state discards as part of the archive event itself
 * (recorded via `priorReviewState` metadata).
 */
export function buildAutoWithdrawEvent(
  manifest: ComponentManifest,
  scope: { kind: 'page' | 'fragment'; name: string },
): RecordEventInput | null {
  const priorState = readReviewState(manifest)
  if (priorState !== 'pending-review') return null

  return {
    action: 'review-withdraw',
    outcome: 'success',
    scope,
    metadata: {
      autoWithdrawn: true,
      reason: 'archive',
      priorState,
    },
  }
}

/**
 * Compute additional metadata for the `archive` audit event capturing
 * the item's prior review state. Returns an empty object for items
 * without review state (current production behavior).
 *
 * `priorReviewState` is a non-prescriptive forensic record: the
 * restore-always-to-draft invariant (Q9 N-B.1) means this metadata
 * is never auto-applied on unarchive. It exists so operators can
 * reconstruct "what state did this item have before it was archived?"
 * via audit-log query alone, without re-reading the historical manifest.
 */
export function archiveReviewMetadata(manifest: ComponentManifest): Record<string, unknown> {
  const priorState = readReviewState(manifest)
  if (!priorState) return {}
  return { priorReviewState: priorState }
}

/**
 * Strip `reviewState` from a restored (unarchived) manifest. Per
 * `design-soft-delete.md` Q9 N-B.1: restore always to draft; the
 * absence of `reviewState` IS the draft state in the
 * review-workflow's data model. Author re-submits if review needed.
 *
 * Returns the manifest unchanged when no review state was set.
 */
export function stripReviewStateForRestore(manifest: ComponentManifest): ComponentManifest {
  if (readReviewState(manifest) === undefined) return manifest
  const { reviewState: _strip, ...rest } = manifest as ComponentManifest & { reviewState?: unknown }
  return rest as ComponentManifest
}
