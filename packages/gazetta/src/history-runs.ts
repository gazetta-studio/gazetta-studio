/**
 * The per-run index: which items and revisions an agent run wrote
 * (design-agent-access.md Q48). Zero-byte files inside history's own
 * folder, so the index exists only where history does and goes with it:
 *
 *   {history}/runs/{runId}/items/{encoded item}     one per item the run touched
 *   {history}/runs/{runId}/revisions/{revisionId}   one per revision the run wrote
 *
 * Items are encoded as the other sidecars encode them: `pages.home`,
 * `fragments.header`, `assets.hero`, with `:<locale>` for a language
 * version (`pages.home:fr`). Paths that aren't an item's manifest
 * (asset bytes, `site.config.ts`) aren't indexed; the run's revisions,
 * which list every path they wrote, cover them.
 *
 * Nothing rebuilds this index from history: it is written with each
 * revision, and drift is a bug, not something a reindex should paper
 * over.
 *
 * Per-edge files, no aggregate: two instances writing for the same run
 * write the same zero-byte paths, so they can't conflict.
 */
import { encodeRefName } from './hash.js'
import { isRunId } from './request-origin.js'
import type { StorageProvider } from './types.js'

const ITEM_MANIFEST = /^(pages|fragments)\/(.+)\/(?:page|fragment)(?:\.([^/.]+))?\.json$/
const ASSET_MANIFEST = /^assets\/([^.]+)\.asset(?:\.([^/]+))?\.json$/

/**
 * The index entry for a content path, or null when the path isn't an
 * item's manifest. A dotted name can't be encoded (dots are reserved);
 * such a path isn't indexed either.
 */
export function runItemName(path: string): string | null {
  const item = ITEM_MANIFEST.exec(path)
  const asset = item ? null : ASSET_MANIFEST.exec(path)
  const match = item ?? asset
  if (!match) return null
  const [kind, name, selector] = item ? [item[1], item[2], item[3]] : ['assets', asset![1], asset![2]]
  if (name!.includes('.')) return null
  return `${kind}.${encodeRefName(name!)}${selector ? `:${selector}` : ''}`
}

export interface RunIndex {
  /** Record that `revisionId` belongs to `runId` and wrote `paths`. */
  record(runId: string, revisionId: string, paths: readonly string[]): Promise<void>
  /** Encoded items the run touched, sorted. */
  listItems(runId: string): Promise<string[]>
  /** Revision ids the run wrote, unsorted. */
  listRevisions(runId: string): Promise<string[]>
  /** Run ids that have an index folder. */
  listRuns(): Promise<string[]>
  /** Remove the run's folder. */
  deleteRun(runId: string): Promise<void>
}

/** The run index under `historyRoot` (`.gazetta/history` by default). */
export function createRunIndex(storage: StorageProvider, historyRoot: string): RunIndex {
  const runsRoot = `${historyRoot}/runs`
  const runPath = (runId: string): string => {
    if (!isRunId(runId)) throw new Error(`invalid run id "${runId}"`)
    return `${runsRoot}/${runId}`
  }

  async function touch(dir: string, name: string): Promise<void> {
    await storage.mkdir(dir)
    await storage.writeFile(`${dir}/${name}`, '')
  }

  async function names(dir: string): Promise<string[]> {
    if (!(await storage.exists(dir))) return []
    return (await storage.readDir(dir)).filter(e => !e.isDirectory).map(e => e.name)
  }

  return {
    async record(runId, revisionId, paths) {
      const run = runPath(runId)
      const items = new Set(paths.map(runItemName).filter((n): n is string => n !== null))
      for (const item of items) await touch(`${run}/items`, item)
      await touch(`${run}/revisions`, revisionId)
    },
    async listItems(runId) {
      return (await names(`${runPath(runId)}/items`)).sort()
    },
    async listRevisions(runId) {
      return names(`${runPath(runId)}/revisions`)
    },
    async listRuns() {
      if (!(await storage.exists(runsRoot))) return []
      return (await storage.readDir(runsRoot)).filter(e => e.isDirectory && isRunId(e.name)).map(e => e.name)
    },
    async deleteRun(runId) {
      await storage.rm(runPath(runId))
    },
  }
}
