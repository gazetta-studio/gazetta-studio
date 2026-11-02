/**
 * What reverting an agent run would do (design-agent-access.md Q48,
 * #1730), worked out from history alone: for each item the run touched,
 * its version before the run, its version after the run, whether the run
 * created it, and whether it changed since. Pure: the caller loads the
 * revisions and the current hashes; `run-revert.ts` carries the plan out.
 */
import { runItemName } from './history-runs.js'

/** One revision as the planner needs it: what it wrote, and its snapshot. */
export interface PlanRevision {
  readonly id: string
  /** Paths the revision wrote (`Revision.items`). */
  readonly items: readonly string[]
  /** `path → content hash`; required for the run's revisions and the ones just before them. */
  readonly snapshot?: Readonly<Record<string, string>>
}

export interface PlanInput {
  /** Every revision in history, oldest first. */
  readonly revisions: readonly PlanRevision[]
  /** The ids of the run's revisions (from the run index). */
  readonly runRevisions: ReadonlySet<string>
  /** The run's items as the run index lists them (`pages.home`, `pages.home:fr`). */
  readonly items: readonly string[]
  /** The current content hash of each path the run wrote; null when the file is gone. */
  readonly current: ReadonlyMap<string, string | null>
}

export interface PlannedItem {
  /** The run index's name for it: `pages.home`, `fragments.header:fr`, `assets.hero`. */
  readonly item: string
  /** The manifest's path: `pages/home/page.fr.json`. */
  readonly path: string
  readonly kind: 'page' | 'fragment' | 'asset'
  readonly name: string
  readonly locale?: string
  /**
   * The version before the run: a content hash, null when the item didn't
   * exist, undefined when history no longer holds the revision before it.
   */
  readonly before: string | null | undefined
  /** The version the run left: a content hash, or null when the run deleted it. */
  readonly after: string | null
  /** The current version: a content hash, or null when the item is gone. */
  readonly current: string | null
  /** The run created the item: it didn't exist before the run. */
  readonly created: boolean
  /** Someone changed the item since the run (Q48). */
  readonly changed: boolean
}

const ITEM_PATH = /^(pages|fragments)\/(.+)\/(?:page|fragment)(?:\.([^/.]+))?\.json$/
const ASSET_PATH = /^assets\/([^.]+)\.asset(?:\.([^/]+))?\.json$/

/** The kind, name and locale a manifest path names. */
export function itemOfPath(path: string): Pick<PlannedItem, 'kind' | 'name' | 'locale'> | null {
  const item = ITEM_PATH.exec(path)
  if (item) {
    return { kind: item[1] === 'pages' ? 'page' : 'fragment', name: item[2]!, ...(item[3] ? { locale: item[3] } : {}) }
  }
  const asset = ASSET_PATH.exec(path)
  return asset ? { kind: 'asset', name: asset[1]!, ...(asset[2] ? { locale: asset[2] } : {}) } : null
}

/**
 * The revisions whose snapshots the plan reads: the run's own, and the
 * one just before each of them.
 */
export function revisionsToRead(order: readonly string[], runRevisions: ReadonlySet<string>): string[] {
  const ids = new Set<string>()
  order.forEach((id, i) => {
    if (!runRevisions.has(id)) return
    ids.add(id)
    if (i > 0) ids.add(order[i - 1]!)
  })
  return [...ids]
}

/** The plan, one entry per item the run index lists, in its order. */
export function planRevert(input: PlanInput): PlannedItem[] {
  const listed = new Set(input.items)
  // The paths each listed item went by in the run's revisions.
  const paths = new Map<string, string>()
  for (const rev of input.revisions) {
    if (!input.runRevisions.has(rev.id)) continue
    for (const path of rev.items) {
      const item = runItemName(path)
      if (item && listed.has(item) && !paths.has(item)) paths.set(item, path)
    }
  }

  const plan: PlannedItem[] = []
  for (const item of input.items) {
    const path = paths.get(item)
    const parsed = path ? itemOfPath(path) : null
    if (!path || !parsed) continue
    let first = -1
    let last = -1
    input.revisions.forEach((rev, i) => {
      if (!input.runRevisions.has(rev.id) || !rev.items.includes(path)) return
      if (first === -1) first = i
      last = i
    })
    if (first === -1) continue
    const previous = first > 0 ? input.revisions[first - 1]!.snapshot : undefined
    const before = previous === undefined ? undefined : (previous[path] ?? null)
    const after = input.revisions[last]!.snapshot?.[path] ?? null
    const current = input.current.get(path) ?? null
    plan.push({
      item,
      path,
      ...parsed,
      before,
      after,
      current,
      created: before === null,
      changed: current !== after,
    })
  }
  return plan
}
