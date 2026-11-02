/**
 * Reverting an agent run item by item (design-agent-access.md Q48, Q50,
 * #1730). `loadRunPlan` reads history and the run index into a plan
 * (`run-revert-plan.ts`); `revertRun` carries it out:
 *
 * - an item the run changed goes back to its version before the run,
 *   through the single save (validation, hooks, audit and history run);
 * - an item changed since the run is skipped unless the caller forces it;
 * - an item the run created is archived, by the caller's archive core;
 * - an item that can't be saved or archived is skipped with the reason.
 *
 * Saves come before archives, so a page put back to no longer use a
 * fragment the run created doesn't keep that fragment in use.
 */
import { createHash } from 'node:crypto'
import { FragmentNotFoundError, prepareFragmentSave } from './fragments/save.js'
import type { HistoryProvider } from './history.js'
import { PageNotFoundError, preparePageSave } from './pages/save.js'
import { planRevert, revisionsToRead, type PlannedItem, type PlanRevision } from './run-revert-plan.js'
import {
  saveManifestCore,
  type SaveAuditRecorder,
  type SavePrincipal,
  type SaveResult,
  type SaveSourceWiring,
} from './manifest-save.js'
import type { HookFiringEmitter, HookRegistry } from './hooks/index.js'
import type { Site } from './site-loader.js'
import type { FragmentManifest, PageManifest } from './types.js'
import type { ValidatorRegistry } from './validation/registry.js'
import type { ValidationScanner } from './validation/scanner.js'

/** The run's plan, or null when history has no run by that id. */
export async function loadRunPlan(source: SaveSourceWiring, runId: string): Promise<PlannedItem[] | null> {
  const history = source.history
  const runs = history?.runs
  if (!history || !runs) return null
  const runRevisions = new Set(await runs.listRevisions(runId))
  if (runRevisions.size === 0) return null
  const items = await runs.listItems(runId)
  const order = (await history.listRevisions()).map(r => r.id).reverse()
  const toRead = new Set(revisionsToRead(order, runRevisions))
  const revisions: PlanRevision[] = await Promise.all(
    order.map(async id => {
      if (!toRead.has(id)) return { id, items: [] }
      const manifest = await history.readRevision(id)
      return { id, items: manifest.items, snapshot: manifest.snapshot }
    }),
  )
  const paths = new Set(revisions.filter(r => runRevisions.has(r.id)).flatMap(r => r.items))
  const current = new Map<string, string | null>()
  for (const path of paths) current.set(path, await currentHash(source, path))
  return planRevert({ revisions, runRevisions, items, current })
}

/** The content hash history would give the file now; null when it's gone. */
async function currentHash(source: SaveSourceWiring, path: string): Promise<string | null> {
  const full = source.contentRoot.path(path)
  if (!(await source.storage.exists(full))) return null
  const text = await source.storage.readFile(full)
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

export type RevertOutcome =
  | { readonly status: 'reverted' }
  | { readonly status: 'archived' }
  | { readonly status: 'skipped-changed' }
  | { readonly status: 'skipped-in-use'; readonly reason: string }
  | { readonly status: 'skipped-failed'; readonly reason: string }

/** What archiving a created item came to. */
export type ArchiveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly inUse: boolean; readonly reason: string }

export interface RevertRunInput {
  readonly plan: readonly PlannedItem[]
  /** Items (`pages.about`) to revert although they changed since the run. */
  readonly force: readonly string[]
  readonly site: Site
  readonly source: SaveSourceWiring & { readonly history?: HistoryProvider }
  readonly principal: SavePrincipal
  readonly audit: SaveAuditRecorder
  readonly validators: ValidatorRegistry
  readonly hooks?: HookRegistry
  readonly hookAuditEmit?: HookFiringEmitter
  readonly scanner?: ValidationScanner
  readonly requestId?: string
  /** Archives an item the run created, through the archive core. */
  readonly archive: (kind: 'page' | 'fragment', name: string) => Promise<ArchiveOutcome>
}

export interface RevertedItem {
  readonly item: string
  readonly kind: PlannedItem['kind']
  readonly name: string
  readonly locale?: string
  readonly outcome: RevertOutcome
}

export async function revertRun(input: RevertRunInput): Promise<RevertedItem[]> {
  const forced = new Set(input.force)
  const outcomes = new Map<string, RevertOutcome>()
  const archives: PlannedItem[] = []
  for (const item of input.plan) {
    const early = decide(item, forced)
    if (early) outcomes.set(item.item, early)
    else if (item.created) archives.push(item)
    else outcomes.set(item.item, await restore(input, item))
  }
  for (const item of archives) {
    const archived = await input.archive(item.kind as 'page' | 'fragment', item.name)
    outcomes.set(
      item.item,
      archived.ok
        ? { status: 'archived' }
        : archived.inUse
          ? { status: 'skipped-in-use', reason: archived.reason }
          : { status: 'skipped-failed', reason: archived.reason },
    )
  }
  return input.plan.map(item => ({
    item: item.item,
    kind: item.kind,
    name: item.name,
    ...(item.locale ? { locale: item.locale } : {}),
    outcome: outcomes.get(item.item)!,
  }))
}

/** The outcome an item gets without a write, or null when it needs one. */
function decide(item: PlannedItem, forced: ReadonlySet<string>): RevertOutcome | null {
  if (item.kind === 'asset') {
    return { status: 'skipped-failed', reason: "Assets aren't reverted yet; change it in the asset library" }
  }
  if (item.before === undefined) {
    return { status: 'skipped-failed', reason: 'Its version before the run is no longer in history' }
  }
  if (item.current === item.before) return { status: 'reverted' }
  if (item.changed && !forced.has(item.item)) return { status: 'skipped-changed' }
  if (item.created && item.locale) {
    return {
      status: 'skipped-failed',
      reason: 'The run added this language version; archiving works on the whole item, so remove it in the admin',
    }
  }
  if (item.created && item.current === null) return { status: 'reverted' }
  return null
}

/** Writes the item's version from before the run back through the single save. */
async function restore(input: RevertRunInput, item: PlannedItem): Promise<RevertOutcome> {
  const history = input.source.history!
  const manifest = JSON.parse(new TextDecoder().decode(await history.readBlob(item.before!))) as Record<string, unknown>
  const common = {
    name: item.name,
    locale: item.locale,
    create: item.current === null,
    site: input.site,
    source: input.source,
    principal: input.principal,
    audit: input.audit,
    validators: input.validators,
    hooks: input.hooks,
    hookAuditEmit: input.hookAuditEmit,
    scanner: input.scanner,
    requestId: input.requestId,
  }
  let prepared
  try {
    prepared =
      item.kind === 'page'
        ? await preparePageSave({ ...common, body: manifest as Partial<PageManifest> & Record<string, unknown> })
        : await prepareFragmentSave({
            ...common,
            body: manifest as Partial<FragmentManifest> & Record<string, unknown>,
          })
  } catch (err) {
    if (err instanceof PageNotFoundError || err instanceof FragmentNotFoundError) {
      return { status: 'skipped-failed', reason: err.message }
    }
    throw err
  }
  if (!prepared.ok) return { status: 'skipped-failed', reason: prepared.message }
  // The stored version exactly: an update merges the body over the stored
  // manifest, which would keep fields the run added.
  return outcomeOf(await saveManifestCore({ ...prepared.save, manifest }))
}

function outcomeOf(result: SaveResult): RevertOutcome {
  if (result.ok) return { status: 'reverted' }
  switch (result.code) {
    case 'VALIDATION_FAILED':
      return {
        status: 'skipped-failed',
        reason: `It no longer passes the save's checks: ${result.issues.map(i => i.message).join('; ')}`,
      }
    case 'HOOK_CANCELLED':
      return { status: 'skipped-failed', reason: `A beforeSave hook refused it: ${result.reason}` }
    case 'STALE':
      return { status: 'skipped-changed' }
    default:
      return { status: 'skipped-failed', reason: 'message' in result ? String(result.message) : result.code }
  }
}
