/**
 * Publish request storage (design-review-workflow.md "Storage", review
 * workflow cut 12). Requests live on the SOURCE the author publishes
 * from, so a public production target can require approval
 * (design-public-storage.md Q5):
 *
 *   .gazetta/publish-requests/{target}/{kind}/{name}/{request-id}.json
 *   .gazetta/publish-requests/{target}/{kind}/{name}/{request-id}/approvers/   (cut 13's per-approver sidecars)
 *   .gazetta/publish-requests/{target}/pending/{itemRefToFilename(item)}@{request-id}
 *
 * `{kind}` is the singular item kind, `{name}` and `{target}` are
 * encoded with `encodeRefName`, as review state and the dependency
 * indices encode them. One file per request and one zero-byte marker
 * per pending request: no aggregate file, so two admin instances
 * creating requests never write the same path.
 *
 * This module owns paths and JSON only. Which requests a publish makes,
 * and what they wait for, is the gate's decision (publish-approval-gate.ts).
 */
import { randomBytes } from 'node:crypto'
import type { ContentRoot } from '../content-root.js'
import { itemRefToFilename, type ItemRef } from '../dep-sidecars.js'
import { encodeRefName } from '../hash.js'
import { stateFolderPath } from '../state-folders.js'

export type PublishRequestKind = 'page' | 'fragment'

/** States a publish request moves through; cut 12 only creates `publish-pending`. */
export type PublishRequestState = 'publish-pending' | 'publish-approved' | 'published'

export interface PublishRequestRecord {
  readonly id: string
  readonly target: string
  readonly kind: PublishRequestKind
  readonly name: string
  /** The item string as the publish named it (`pages/about`, `pages/about:fr`). */
  readonly item: string
  /** The editable target the request publishes from, so the approval re-hashes the right content. */
  readonly source?: string
  /** `Principal.id` of the person who made the request. */
  readonly requestedBy: string
  /** ISO timestamp. */
  readonly requestedAt: string
  /** The target's `requiredPublishApprovers` when the request was made (default 1). */
  readonly requiredPublishApprovers: number
  readonly state: PublishRequestState
  /**
   * One hash per manifest the publish would copy, keyed by its path from
   * the content root (`pages/about/page.json`, `pages/about/page.fr.json`):
   * the approval re-hashes them (lock 3).
   */
  readonly hashes: Readonly<Record<string, string>>
  /** Requests of the same run this one waits for (fragments the page uses that the target lacks). */
  readonly waitsFor: readonly string[]
}

let sequence = 0

/**
 * A request id unique across instances: the clock's milliseconds, a
 * per-process sequence and a random suffix, as history revision ids
 * (`rev-<ms>-<seq>-<8 hex>`).
 */
export function newPublishRequestId(now: number = Date.now()): string {
  sequence = (sequence + 1) % 1_000_000
  return `preq-${now}-${sequence}-${randomBytes(4).toString('hex')}`
}

/** `pages/about:fr` → its kind, name and locale; null for any other item (templates, assets). */
export function parseRequestItem(item: string): { kind: PublishRequestKind; name: string; locale?: string } | null {
  const m = /^(pages|fragments)\/([^:]+)(?::([^:]+))?$/.exec(item)
  if (!m) return null
  const kind = m[1] === 'pages' ? 'page' : 'fragment'
  return m[3] ? { kind, name: m[2], locale: m[3] } : { kind, name: m[2] }
}

function itemRefOf(record: Pick<PublishRequestRecord, 'item'>): ItemRef {
  const parsed = parseRequestItem(record.item)
  if (!parsed) throw new Error(`Not a page or fragment item: ${record.item}`)
  return { source: parsed.kind, name: parsed.name, ...(parsed.locale ? { locale: parsed.locale } : {}) }
}

// The target's name goes in the path as it is: target names are config
// keys and may contain dots, which `encodeRefName` reserves for item names.
function requestDir(root: ContentRoot, target: string, kind: PublishRequestKind, name: string): string {
  return root.path(stateFolderPath('publish-requests', target, kind, encodeRefName(name)))
}

export function publishRequestPath(
  root: ContentRoot,
  target: string,
  kind: PublishRequestKind,
  name: string,
  id: string,
): string {
  return `${requestDir(root, target, kind, name)}/${id}.json`
}

export function publishRequestApproversDir(
  root: ContentRoot,
  target: string,
  kind: PublishRequestKind,
  name: string,
  id: string,
): string {
  return `${requestDir(root, target, kind, name)}/${id}/approvers`
}

export function pendingPublishRequestsDir(root: ContentRoot, target: string): string {
  return root.path(stateFolderPath('publish-requests', target, 'pending'))
}

/** The pending marker's file name: the encoded item, `@`, the request id. */
export function pendingMarkerName(item: ItemRef, id: string): string {
  return `${itemRefToFilename(item)}@${id}`
}

/** Write a request, its (empty) approvers folder and its pending marker. */
export async function writePublishRequest(root: ContentRoot, record: PublishRequestRecord): Promise<void> {
  const { storage } = root
  await storage.writeFile(
    publishRequestPath(root, record.target, record.kind, record.name, record.id),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  await storage.mkdir(publishRequestApproversDir(root, record.target, record.kind, record.name, record.id))
  await storage.writeFile(
    `${pendingPublishRequestsDir(root, record.target)}/${pendingMarkerName(itemRefOf(record), record.id)}`,
    '',
  )
}

export async function readPublishRequest(
  root: ContentRoot,
  target: string,
  kind: PublishRequestKind,
  name: string,
  id: string,
): Promise<PublishRequestRecord | null> {
  try {
    return JSON.parse(await root.storage.readFile(publishRequestPath(root, target, kind, name, id)))
  } catch {
    return null
  }
}

/** The pending requests for a target: one directory listing. */
export async function listPendingPublishRequests(
  root: ContentRoot,
  target: string,
): Promise<{ readonly marker: string; readonly id: string }[]> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await root.storage.readDir(pendingPublishRequestsDir(root, target))
  } catch {
    return []
  }
  return entries
    .filter(e => !e.isDirectory)
    .flatMap(e => {
      const at = e.name.lastIndexOf('@')
      return at > 0 ? [{ marker: e.name, id: e.name.slice(at + 1) }] : []
    })
}
