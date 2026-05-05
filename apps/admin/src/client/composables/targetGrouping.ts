/**
 * Target grouping — shared logic for scaling from flat (≤3 targets) to
 * environment-grouped (4+) across sync indicators, the switcher menu,
 * and the Publish picker.
 *
 * Design (design-editor-ux.md "Scaling to 4+ targets"): when the total
 * target count is ≥ 4, targets sharing an `environment` collapse into
 * a group across all target-referencing surfaces. Groups of 1 stay
 * flat; targets with no environment set display ungrouped alongside
 * groups.
 *
 * Grouping is presentation only — environments remain non-hierarchical
 * in the model. Keep this logic pure so the threshold lives in one
 * place and every surface renders consistently.
 */
import type { TargetInfo } from '../api/client.js'

/** Threshold above which targets collapse into environment groups. */
export const GROUPING_THRESHOLD = 4

/**
 * A group of targets sharing the same `environment`. Members preserve
 * declaration order from site.config.ts.
 */
export interface TargetGroup {
  /** Environment value, e.g. 'production'. */
  environment: string
  members: TargetInfo[]
}

/** Should the provided target list render as groups? */
export function shouldGroup(totalTargetCount: number): boolean {
  return totalTargetCount >= GROUPING_THRESHOLD
}

/**
 * Group targets by environment, preserving declaration order both
 * within groups and across groups (first appearance of each env
 * defines the group's slot).
 */
export function groupByEnvironment(targets: TargetInfo[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>()
  for (const t of targets) {
    const env = t.environment ?? 'local'
    let g = groups.get(env)
    if (!g) {
      g = { environment: env, members: [] }
      groups.set(env, g)
    }
    g.members.push(t)
  }
  return [...groups.values()]
}

/**
 * Render-shape for a surface: either a single target (flat) or a group
 * (collapsed). Used by sync indicators and the switcher menu to decide
 * per-item whether to render a plain chip/item or a group affordance.
 *
 * A group with only one member is rendered flat regardless — the design
 * rule "groups of 1 stay flat" means the author never sees a group
 * affordance for a single-member env.
 */
export type GroupedEntry = { kind: 'single'; target: TargetInfo } | { kind: 'group'; group: TargetGroup }

/**
 * Compute the render shape for a set of targets. When `totalTargetCount`
 * is below the threshold, every target is returned as 'single'.
 * Otherwise targets are grouped by environment, with 1-member groups
 * flattened back to 'single' entries.
 */
export function groupedEntries(targets: TargetInfo[], totalTargetCount: number): GroupedEntry[] {
  if (!shouldGroup(totalTargetCount)) {
    return targets.map(t => ({ kind: 'single', target: t }))
  }
  return groupByEnvironment(targets).map(g =>
    g.members.length === 1 ? { kind: 'single', target: g.members[0] } : { kind: 'group', group: g },
  )
}
