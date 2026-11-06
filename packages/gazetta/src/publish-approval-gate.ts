/**
 * The publish-approval gate (design-review-workflow.md locks 1, 5, 6 and
 * "How the gate meets the shared publish function"; review workflow cut
 * 12). Step 0 of the shared target-publish function, before any write:
 *
 *   - A target without `requiresPublishApproval: true` passes.
 *   - A gated target with no signed-in user (the CLI) is refused with
 *     lock 6's message: a run without a Principal can't request.
 *   - A gated target with a user who holds `publish:request` gets one
 *     publish request per page or fragment item string, written on the
 *     source; nothing is written to the target.
 *
 * Removals to a gated target are refused: removal requests come with
 * target removal cut 2. An approved publish passing the gate by its
 * request id is cut 13's path (`approvedRequestId` below is reserved).
 *
 * Gazetta tokens (design-agent-access.md Q20, Q29): on a gated target a
 * token's publish creates the request whether or not it's elevated; an
 * elevation gives publish rights, never the approval. Tokens keep
 * `publish:request` (auth/token-cap.ts), so an un-elevated token reaches
 * this gate and creates the request.
 */
import { siteAssetHashes } from './asset-hashes.js'
import { capabilityGrants, type Principal } from './auth/index.js'
import { createContentRoot } from './content-root.js'
import { hashManifest } from './hash.js'
import { localItemHashes } from './item-hashes.js'
import { localeFilename, normalizeLocale } from './locale.js'
import type { PublishRemovalRef } from './publish-remove.js'
import type { PublishSnapshot } from './publish-snapshot.js'
import {
  newPublishRequestId,
  parseRequestItem,
  writePublishRequest,
  type PublishRequestRecord,
} from './review/publish-requests.js'
import { collectFragmentRefs, listSidecars } from './sidecars.js'
import { templateHashesFrom, type TemplateInfo } from './templates-scan.js'
import { getType, type FragmentManifest, type StorageProvider, type TargetConfig } from './types.js'

/** Whether publishing to the target needs approval (`targets.{name}.requiresPublishApproval`). */
export function requiresPublishApproval(config: TargetConfig | undefined): boolean {
  return config?.requiresPublishApproval === true
}

/** Lock 6: a gated target published to without a signed-in user (the CLI). */
export class PublishApprovalRequiredError extends Error {
  constructor(readonly target: string) {
    super(`${target} requires publish approval — request it from the admin.`)
    this.name = 'PublishApprovalRequiredError'
  }
}

/** A gated target published to by someone who can't request a publish. */
export class PublishRequestForbiddenError extends Error {
  constructor(
    readonly target: string,
    readonly role: string,
  ) {
    super(`${target} requires publish approval, and role "${role}" can't request it (needs "publish:request").`)
    this.name = 'PublishRequestForbiddenError'
  }
}

/** A gated publish with no page or fragment to request (templates or assets only). */
export class NothingToRequestError extends Error {
  constructor(readonly target: string) {
    super(`${target} requires publish approval, and only pages and fragments can be requested. Nothing was changed.`)
    this.name = 'NothingToRequestError'
  }
}

/** Removals sent to a gated target: removal requests come with target removal cut 2. */
export class GatedRemovalError extends Error {
  constructor(readonly target: string) {
    super(`${target} requires publish approval, and removals can't be requested yet. Nothing was changed.`)
    this.name = 'GatedRemovalError'
  }
}

export interface PublishApprovalGateInput {
  readonly targetName: string
  readonly targetStorage: StorageProvider
  readonly targetConfig: TargetConfig | undefined
  readonly snapshot: PublishSnapshot
  readonly sourceName: string | undefined
  readonly items: readonly string[]
  readonly templateInfos: readonly TemplateInfo[]
  readonly removals: readonly PublishRemovalRef[]
  /** The signed-in user; none from the CLI. */
  readonly requester: Principal | undefined
  /** Reserved for cut 13: an approved publish passes the gate by its request id. */
  readonly approvedRequestId?: string
  readonly now?: () => Date
}

export type PublishApprovalGateOutcome =
  | { readonly kind: 'pass' }
  | { readonly kind: 'requested'; readonly requests: readonly PublishRequestRecord[] }

export async function publishApprovalGate(input: PublishApprovalGateInput): Promise<PublishApprovalGateOutcome> {
  const { targetName, targetConfig, requester } = input
  if (!requiresPublishApproval(targetConfig)) return { kind: 'pass' }
  if (!requester) throw new PublishApprovalRequiredError(targetName)
  if (!capabilityGrants(requester.capabilities, 'publish:request')) {
    throw new PublishRequestForbiddenError(targetName, requester.role)
  }
  if (input.removals.length > 0) throw new GatedRemovalError(targetName)

  if (requestItemsOf(input.items).length === 0) throw new NothingToRequestError(targetName)
  const requests = await planRequests(input, requester)
  for (const record of requests) await writePublishRequest(input.snapshot.liveRoot, record)
  return { kind: 'requested', requests }
}

/**
 * The item strings a gated publish requests: one per page or fragment
 * item, once each. Templates and assets aren't requested.
 */
export function requestItemsOf(items: readonly string[]): string[] {
  // `pages/home:FR` and `pages/home:fr` are one item, as publishing normalizes locales.
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const parsed = parseRequestItem(item)
    if (!parsed) continue
    const key = `${parsed.kind}/${parsed.name}:${parsed.locale ? normalizeLocale(parsed.locale) : ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** One request per page or fragment item string. */
async function planRequests(input: PublishApprovalGateInput, requester: Principal): Promise<PublishRequestRecord[]> {
  const { snapshot, targetConfig } = input
  const { site } = snapshot
  const staticTarget = targetConfig ? getType(targetConfig) === 'static' : true
  const templateHashes = templateHashesFrom([...input.templateInfos])
  const hashes = localItemHashes(site, {
    templateHashes,
    assetHashes: await siteAssetHashes(site),
    staticTarget,
    includeFragments: true,
  })
  const requestedAt = (input.now?.() ?? new Date()).toISOString()

  const planned = requestItemsOf(input.items).map(item => ({
    item,
    ...parseRequestItem(item)!,
    id: newPublishRequestId(),
  }))

  // Fragments of this run, by name, with their request ids.
  const fragmentRequests = new Map<string, string[]>()
  for (const p of planned) {
    if (p.kind === 'fragment') fragmentRequests.set(p.name, [...(fragmentRequests.get(p.name) ?? []), p.id])
  }
  const waitable = await fragmentsToWaitFor(input, [...fragmentRequests.keys()], staticTarget, templateHashes)

  return planned.map(p => {
    const prefix = p.kind === 'page' ? 'pages' : 'fragments'
    const translations = p.kind === 'page' ? site.pageLocales.get(p.name) : site.fragmentLocales.get(p.name)
    // A bare item covers the translations the publish copies to this
    // target: all of them, or those in `targets.{name}.locales`.
    const allowed = targetConfig?.locales
    const locales: (string | undefined)[] = p.locale
      ? [normalizeLocale(p.locale)]
      : [undefined, ...[...(translations?.locales.keys() ?? [])].filter(l => !allowed || allowed.includes(l))]
    const recorded: Record<string, string> = {}
    for (const locale of locales) {
      const hash = hashes.get(locale ? `${prefix}/${p.name}:${locale}` : `${prefix}/${p.name}`)
      if (hash) recorded[`${prefix}/${p.name}/${localeFilename(p.kind, locale ?? null)}`] = hash
    }
    const waitsFor =
      p.kind === 'page'
        ? [...fragmentsUsedBy(input, p.name, p.locale)].flatMap(f => (waitable.has(f) ? fragmentRequests.get(f)! : []))
        : []
    return {
      id: p.id,
      target: input.targetName,
      kind: p.kind,
      name: p.name,
      item: p.item,
      ...(input.sourceName ? { source: input.sourceName } : {}),
      requestedBy: requester.id,
      requestedAt,
      requiredPublishApprovers: targetConfig?.requiredPublishApprovers ?? 1,
      state: 'publish-pending' as const,
      hashes: recorded,
      waitsFor,
    }
  })
}

/**
 * The fragments of the run a page's request waits for (design-review-
 * workflow.md, "Settled by the plan review" item 12): those not on the
 * target yet, by its fragment sidecars. Static targets bake fragments
 * into pages and keep no fragment sidecars, so there a fragment counts
 * when its manifest isn't on the target or differs from the source's.
 */
async function fragmentsToWaitFor(
  input: PublishApprovalGateInput,
  names: readonly string[],
  staticTarget: boolean,
  templateHashes: Map<string, string>,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (names.length === 0) return out
  if (!staticTarget) {
    const onTarget = await listSidecars(input.targetStorage, 'fragments')
    for (const name of names) if (!onTarget.has(name)) out.add(name)
    return out
  }
  const targetRoot = createContentRoot(input.targetStorage)
  for (const name of names) {
    const source = input.snapshot.site.fragments.get(name)
    let onTarget: FragmentManifest | null = null
    try {
      onTarget = JSON.parse(await input.targetStorage.readFile(targetRoot.path(`fragments/${name}/fragment.json`)))
    } catch {
      onTarget = null
    }
    if (
      !onTarget ||
      !source ||
      hashManifest(onTarget, { templateHashes }) !== hashManifest(source, { templateHashes })
    ) {
      out.add(name)
    }
  }
  return out
}

/** Every fragment a page uses, directly or through other fragments, in the versions the request covers. */
function fragmentsUsedBy(input: PublishApprovalGateInput, name: string, locale: string | undefined): Set<string> {
  const { site } = input.snapshot
  const translations = site.pageLocales.get(name)?.locales
  const manifests = locale
    ? [translations?.get(normalizeLocale(locale)) ?? site.pages.get(name)]
    : [site.pages.get(name), ...(translations?.values() ?? [])]
  const used = new Set<string>()
  const visit = (refs: string[]) => {
    for (const ref of refs) {
      if (used.has(ref)) continue
      used.add(ref)
      visit(collectFragmentRefs(site.fragments.get(ref)?.components))
    }
  }
  for (const m of manifests) if (m) visit(collectFragmentRefs(m.components))
  return used
}
