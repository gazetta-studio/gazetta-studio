/**
 * Publish request storage (review workflow cut 12, #1787): paths under
 * the `publish-requests` state folder, ids unique across instances, the
 * request JSON, and the pending marker named `{itemRefToFilename}@{id}`
 * (design-review-workflow.md, "Settled by the plan review" items 2, 9).
 */
import { describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { itemRefToFilename } from '../src/dep-sidecars.js'
import {
  listPendingPublishRequests,
  newPublishRequestId,
  parseRequestItem,
  pendingMarkerName,
  publishRequestApproversDir,
  publishRequestPath,
  readPublishRequest,
  writePublishRequest,
  type PublishRequestRecord,
} from '../src/review/publish-requests.js'
import { isStateFolderSafeOnPublic, stateFolderPath } from '../src/state-folders.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const record = (over: Partial<PublishRequestRecord> = {}): PublishRequestRecord => ({
  id: 'preq-1-1-aaaaaaaa',
  target: 'production',
  kind: 'page',
  name: 'blog/post',
  item: 'pages/blog/post',
  source: 'local',
  requestedBy: 'alice',
  requestedAt: '2026-11-06T10:00:00.000Z',
  requiredPublishApprovers: 2,
  state: 'publish-pending',
  hashes: { 'pages/blog/post/page.json': 'ab12cd34', 'pages/blog/post/page.fr.json': 'ef56ab78' },
  waitsFor: ['preq-1-2-bbbbbbbb'],
  ...over,
})

describe('publish request storage', () => {
  it('registers publish-requests as a state folder that is not safe on public targets', () => {
    expect(isStateFolderSafeOnPublic('publish-requests')).toBe(false)
  })

  it('builds the request, approvers and pending paths through stateFolderPath', () => {
    const root = createContentRoot(memoryStorage(), 'site')
    const base = root.path(stateFolderPath('publish-requests', 'production', 'page', 'blog.post'))
    expect(publishRequestPath(root, 'production', 'page', 'blog/post', 'preq-x')).toBe(`${base}/preq-x.json`)
    expect(publishRequestApproversDir(root, 'production', 'page', 'blog/post', 'preq-x')).toBe(
      `${base}/preq-x/approvers`,
    )
  })

  it('makes ids unique even in the same millisecond', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPublishRequestId(1_700_000_000_000)))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^preq-1700000000000-\d+-[0-9a-f]{8}$/)
  })

  it('round-trips the request JSON', async () => {
    const storage = memoryStorage()
    const root = createContentRoot(storage, '')
    await writePublishRequest(root, record())
    expect(await readPublishRequest(root, 'production', 'page', 'blog/post', 'preq-1-1-aaaaaaaa')).toEqual(record())
    expect(await readPublishRequest(root, 'production', 'page', 'blog/post', 'missing')).toBeNull()
  })

  it('reserves the approvers folder for cut 13', async () => {
    const storage = memoryStorage()
    const made: string[] = []
    const mkdir = storage.mkdir.bind(storage)
    storage.mkdir = async (path: string) => {
      made.push(path)
      return mkdir(path)
    }
    const root = createContentRoot(storage, '')
    await writePublishRequest(root, record())
    expect(made).toEqual(['.gazetta/publish-requests/production/page/blog.post/preq-1-1-aaaaaaaa/approvers'])
  })

  it('writes a zero-byte pending marker named after the item and the id', async () => {
    const storage = memoryStorage()
    const root = createContentRoot(storage, '')
    await writePublishRequest(root, record({ id: 'preq-2-1-cccccccc', item: 'pages/blog/post:fr' }))
    const marker = `${itemRefToFilename({ source: 'page', name: 'blog/post', locale: 'fr' })}@preq-2-1-cccccccc`
    expect(marker).toBe('pages.blog.post:fr@preq-2-1-cccccccc')
    expect(pendingMarkerName({ source: 'page', name: 'blog/post', locale: 'fr' }, 'preq-2-1-cccccccc')).toBe(marker)
    expect(await storage.readFile(`.gazetta/publish-requests/production/pending/${marker}`)).toBe('')
    expect(await listPendingPublishRequests(root, 'production')).toEqual([{ marker, id: 'preq-2-1-cccccccc' }])
  })

  it('parses only page and fragment items', () => {
    expect(parseRequestItem('pages/about')).toEqual({ kind: 'page', name: 'about' })
    expect(parseRequestItem('fragments/header:fr')).toEqual({ kind: 'fragment', name: 'header', locale: 'fr' })
    expect(parseRequestItem('templates/hero')).toBeNull()
    expect(parseRequestItem('assets/logo')).toBeNull()
  })
})
