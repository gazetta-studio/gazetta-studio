/**
 * The bulk save (design-agent-access.md Q46, #1714): several page and
 * fragment saves as one all-or-nothing write with one history revision.
 *
 * It runs the single save's own steps (`manifest-save.ts`): every item's
 * checks first (save-version, review lock, save-delta validation,
 * `beforeSave`), and only when all pass, every write, then one revision,
 * then every item's after-write steps (audit, `afterSave`, cascades,
 * scanner). Items are checked against the batch's result: a page may
 * reference a fragment the same batch creates.
 *
 * A storage failure after the checks passed stops the batch. What was
 * written is recorded as the revision and reported; nothing is rolled
 * back (design-media.md, "Multi-write contract").
 */
import { dirname } from 'node:path'
import {
  InvalidLocaleError as FragmentInvalidLocaleError,
  FragmentNotFoundError,
  prepareFragmentSave,
} from './fragments/save.js'
import { ensureHistoryBaseline, recordWrite } from './history-recorder.js'
import {
  type CheckedSave,
  checkSave,
  finishSave,
  type PreparedSave,
  recordStrictPreWrite,
  recordWriteFailed,
  type SaveAuditRecorder,
  type SaveCheckFailure,
  type SaveManifestInput,
  type SavePrincipal,
  type SaveSourceWiring,
  savedItem,
  writeSave,
} from './manifest-save.js'
import { InvalidLocaleError, PageNotFoundError, preparePageSave } from './pages/save.js'
import { deriveRoute } from './runtime/derive-route.js'
import type { HookFiringEmitter, HookRegistry } from './hooks/index.js'
import type { Site } from './site-loader.js'
import type { FragmentManifest, PageManifest } from './types.js'
import type { ValidatorRegistry } from './validation/registry.js'
import type { ValidationScanner } from './validation/scanner.js'

export interface BulkSaveItem {
  readonly kind: 'page' | 'fragment'
  readonly name: string
  readonly locale?: string
  /** The item's manifest; for an update, fields it leaves out keep their stored values. */
  readonly manifest: Record<string, unknown>
  /** The save-version the caller read; absent for a create. */
  readonly ifMatch?: string
  /** Create the item: nothing may exist under its name. */
  readonly create: boolean
}

export interface BulkSaveInput {
  readonly items: readonly BulkSaveItem[]
  readonly site: Site
  readonly source: SaveSourceWiring
  readonly principal: SavePrincipal
  readonly audit: SaveAuditRecorder
  readonly validators: ValidatorRegistry
  readonly hooks?: HookRegistry
  readonly hookAuditEmit?: HookFiringEmitter
  readonly scanner?: ValidationScanner
  readonly requestId?: string
}

/** An item by its position in the request. */
export interface BulkItemRef {
  readonly index: number
  readonly kind: 'page' | 'fragment'
  readonly name: string
  readonly locale?: string
}

/** Why an item can't be saved, from its wrapper or the save's checks. */
export type BulkItemFailure =
  | SaveCheckFailure
  | { readonly ok: false; readonly code: 'ARCHIVED' | 'EXISTS' | 'NOT_FOUND' | 'BAD_REQUEST'; readonly message: string }

export type BulkSaveResult =
  | {
      readonly ok: true
      readonly revisionId?: string
      readonly items: ReadonlyArray<BulkItemRef & { readonly etag: string }>
    }
  | {
      readonly ok: false
      readonly code: 'CHECK_FAILED'
      readonly failures: ReadonlyArray<BulkItemRef & BulkItemFailure>
    }
  | { readonly ok: false; readonly code: 'AUDIT_FAILED' }
  | {
      readonly ok: false
      readonly code: 'WRITE_FAILED'
      readonly message: string
      readonly revisionId?: string
      readonly written: readonly BulkItemRef[]
      readonly unwritten: readonly BulkItemRef[]
    }

export async function bulkSave(input: BulkSaveInput): Promise<BulkSaveResult> {
  const refs: BulkItemRef[] = input.items.map((item, index) => ({
    index,
    kind: item.kind,
    name: item.name,
    ...(item.locale ? { locale: item.locale } : {}),
  }))

  // Assemble every item against the stored site.
  const failures: Array<BulkItemRef & BulkItemFailure> = []
  const saves: SaveManifestInput[] = []
  for (const [i, item] of input.items.entries()) {
    const prepared = await prepare(input, item)
    if (prepared.ok) saves.push(prepared.save)
    else failures.push({ ...refs[i]!, ...prepared })
  }
  if (failures.length > 0) return { ok: false, code: 'CHECK_FAILED', failures }

  // Check every item against the batch's result, so references to items
  // the batch creates or changes resolve.
  const batchSite = applyToSite(input.site, saves)
  const checked: CheckedSave[] = []
  for (const [i, save] of saves.entries()) {
    const result = await checkSave({ ...save, site: batchSite })
    if (result.ok) checked.push(result)
    else failures.push({ ...refs[i]!, ...result })
  }
  if (failures.length > 0) return { ok: false, code: 'CHECK_FAILED', failures }

  const strict = input.audit.strict === true
  if (strict) {
    for (const save of saves) {
      if (!(await recordStrictPreWrite(save))) return { ok: false, code: 'AUDIT_FAILED' }
    }
  }

  const history = input.source.history
  if (history) await ensureHistoryBaseline({ history, contentRoot: input.source.contentRoot })

  const etags: string[] = []
  for (const [i, save] of saves.entries()) {
    try {
      etags.push(await writeSave(save, checked[i]!))
    } catch (err) {
      if (strict) for (const unwritten of saves.slice(i)) await recordWriteFailed(unwritten)
      const revision = history && i > 0 ? await record(input, saves.slice(0, i), checked) : undefined
      return {
        ok: false,
        code: 'WRITE_FAILED',
        message: (err as Error).message,
        ...(revision ? { revisionId: revision } : {}),
        written: refs.slice(0, i),
        unwritten: refs.slice(i),
      }
    }
  }
  const revisionId = history ? await record(input, saves, checked) : undefined

  for (const [i, save] of saves.entries()) {
    await finishSave(save, checked[i]!, etags[i]!, { recordAudit: !strict })
  }
  return {
    ok: true,
    ...(revisionId ? { revisionId } : {}),
    items: refs.map((ref, i) => ({ ...ref, etag: etags[i]! })),
  }
}

async function prepare(input: BulkSaveInput, item: BulkSaveItem): Promise<PreparedSave | BulkItemFailure> {
  const common = {
    name: item.name,
    locale: item.locale,
    ifMatch: item.ifMatch,
    create: item.create,
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
  try {
    return item.kind === 'page'
      ? await preparePageSave({ ...common, body: item.manifest as Partial<PageManifest> & Record<string, unknown> })
      : await prepareFragmentSave({
          ...common,
          body: item.manifest as Partial<FragmentManifest> & Record<string, unknown>,
        })
  } catch (err) {
    if (err instanceof PageNotFoundError || err instanceof FragmentNotFoundError) {
      return { ok: false, code: 'NOT_FOUND', message: err.message }
    }
    if (err instanceof InvalidLocaleError || err instanceof FragmentInvalidLocaleError) {
      return { ok: false, code: 'BAD_REQUEST', message: err.message }
    }
    throw err
  }
}

/**
 * The site as it will be once the batch is written: the default-language
 * manifests it creates or changes replace the stored ones. Language
 * versions aren't applied; no save-delta validator reads them.
 */
function applyToSite(site: Site, saves: readonly SaveManifestInput[]): Site {
  const pages = new Map(site.pages)
  const fragments = new Map(site.fragments)
  for (const save of saves) {
    if (save.locale) continue
    const dir = dirname(save.manifestPath)
    if (save.kind === 'page') {
      const route = site.pages.get(save.name)?.route ?? deriveRoute(save.name)
      pages.set(save.name, { ...(save.manifest as unknown as PageManifest), route, dir })
    } else {
      fragments.set(save.name, { ...(save.manifest as unknown as FragmentManifest), dir })
    }
  }
  return { ...site, pages, fragments }
}

/** One revision for the written items; it joins the request's run (cut 6). */
async function record(
  input: BulkSaveInput,
  written: readonly SaveManifestInput[],
  checked: readonly CheckedSave[],
): Promise<string> {
  const revision = await recordWrite({
    history: input.source.history!,
    contentRoot: input.source.contentRoot,
    operation: 'save',
    items: written.map((save, i) => savedItem(save, checked[i]!)),
  })
  return revision.id
}
