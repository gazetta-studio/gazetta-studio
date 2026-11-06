/**
 * Audit events for a publish run: one per destination target, each with
 * its own outcome (design-audit.md, "Recording scope"). `success` when
 * every item reached the target; `write-failed` when any didn't, with
 * those items in `metadata.failedItems`. Shared by the admin's publish
 * routes so their events can't drift (#1799).
 */
import type { RecordEventInput } from './audit/index.js'

/** One target's result, as the publish routes report it. */
export interface PublishTargetOutcome {
  readonly target: string
  readonly success: boolean
  readonly error?: string
  readonly failedItems?: readonly { readonly item: string; readonly reason: string }[]
  readonly notPublished?: readonly { readonly item: string; readonly reason: string }[]
}

/** What every event of the run carries. */
export interface PublishAuditBase {
  readonly items: readonly string[]
  readonly source?: string
}

function event(target: string, base: PublishAuditBase, extra: Partial<RecordEventInput>): RecordEventInput {
  return {
    action: 'publish',
    outcome: 'success',
    scope: { kind: 'site', name: target },
    ...extra,
    metadata: { items: base.items, target, source: base.source, ...extra.metadata },
  }
}

/** The event recorded before a target is written to, in strict mode. */
export function publishStartEvent(target: string, base: PublishAuditBase): RecordEventInput {
  return event(target, base, {})
}

/**
 * The event recorded once a target's run is over: `success`, or
 * `write-failed` with the items that didn't reach it. A target that
 * failed as a whole failed every item, with its error as the reason.
 */
export function publishResultEvent(result: PublishTargetOutcome, base: PublishAuditBase): RecordEventInput {
  const failedItems = result.success
    ? [...(result.failedItems ?? []), ...(result.notPublished ?? [])].map(f => ({ item: f.item, reason: f.reason }))
    : base.items.map(item => ({ item, reason: result.error ?? 'unknown' }))
  if (failedItems.length === 0) return event(result.target, base, {})
  return event(result.target, base, { outcome: 'write-failed', metadata: { failedItems } })
}
