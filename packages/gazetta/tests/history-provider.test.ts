/**
 * Unit tests for createHistoryProvider. Uses an in-memory StorageProvider
 * so we exercise the real layout logic (index.json, revisions/, objects/
 * sharding) without touching disk.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHistoryProvider } from '../src/history-provider.js'
import type { RevisionInput } from '../src/history.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function input(items: Record<string, string>, overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    operation: 'save',
    items: new Map(Object.entries(items)),
    ...overrides,
  }
}

/** Revision id matcher: `rev-<unixMillis>` or `rev-<unixMillis>-<seq>`. */
const ID_SHAPE = /^rev-\d{10,}(?:-\d+)?$/

describe('createHistoryProvider', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  describe('recordRevision', () => {
    it('assigns timestamp-based ids (rev-<unixMillis>[-seq])', async () => {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision(input({ 'pages/home': 'a' }))
      const r2 = await h.recordRevision(input({ 'pages/home': 'b' }))
      expect(r1.id).toMatch(ID_SHAPE)
      expect(r2.id).toMatch(ID_SHAPE)
      // Same-millisecond collision resolves via `-<seq>` suffix — both
      // ids must still be distinct and lex-orderable by creation time.
      expect(r1.id).not.toBe(r2.id)
      expect([r1.id, r2.id].sort()).toEqual([r1.id, r2.id])
    })

    it('writes a manifest per revision under revisions/', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/home': 'a' }))
      expect(await storage.exists(`.gazetta/history/revisions/${r.id}.json`)).toBe(true)
    })

    it('stores items as content-addressed blobs (sharded by first 2 hex chars)', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ 'pages/home': 'hello' }))
      // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      const shardedPath = '.gazetta/history/objects/2c/f24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      expect(await storage.exists(shardedPath)).toBe(true)
      expect(await storage.readFile(shardedPath)).toBe('hello')
    })

    it('dedupes unchanged content across revisions (writes blob only once)', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ 'pages/home': 'same', 'pages/about': 'same' }))
      await h.recordRevision(input({ 'pages/home': 'same', 'pages/about': 'changed' }))
      // Two unique contents → two blobs, not four.
      const blobs = [...storage.dump().keys()].filter(k => k.startsWith('.gazetta/history/objects/'))
      expect(blobs).toHaveLength(2)
    })

    it('returns the recorded Revision metadata (without the snapshot)', async () => {
      const h = createHistoryProvider({ storage })
      const rev = await h.recordRevision(
        input({ 'pages/home': 'a' }, { operation: 'publish', source: 'local', message: 'hotfix' }),
      )
      expect(rev.id).toMatch(ID_SHAPE)
      expect(rev).toMatchObject({
        operation: 'publish',
        source: 'local',
        message: 'hotfix',
        items: ['pages/home'],
      })
      expect(rev).not.toHaveProperty('snapshot')
      expect(rev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('sorts item paths deterministically in the manifest', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/z': 'z', 'pages/a': 'a', 'pages/m': 'm' }))
      const manifest = JSON.parse(await storage.readFile(`.gazetta/history/revisions/${r.id}.json`))
      expect(manifest.items).toEqual(['pages/a', 'pages/m', 'pages/z'])
      expect(Object.keys(manifest.snapshot)).toEqual(['pages/a', 'pages/m', 'pages/z'])
    })
  })

  describe('listRevisions', () => {
    it('returns revisions newest-first', async () => {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      const r3 = await h.recordRevision(input({ a: '3' }))
      const list = await h.listRevisions()
      expect(list.map(r => r.id)).toEqual([r3.id, r2.id, r1.id])
    })

    it('honors the limit parameter', async () => {
      const h = createHistoryProvider({ storage })
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await h.recordRevision(input({ a: `${i}` }))).id)
      const list = await h.listRevisions(2)
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe(ids[4])
    })

    it('empty when no revisions exist yet', async () => {
      const h = createHistoryProvider({ storage })
      expect(await h.listRevisions()).toEqual([])
    })
  })

  describe('readRevision', () => {
    it('returns the full manifest with snapshot', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/home': 'a', 'pages/about': 'b' }))
      const m = await h.readRevision(r.id)
      expect(m.items).toEqual(['pages/about', 'pages/home'])
      expect(Object.keys(m.snapshot).sort()).toEqual(['pages/about', 'pages/home'])
    })
  })

  describe('readBlob', () => {
    it('returns the content as bytes for a given hash', async () => {
      const h = createHistoryProvider({ storage })
      const r = await h.recordRevision(input({ 'pages/home': 'hello' }))
      const m = await h.readRevision(r.id)
      const bytes = await h.readBlob(m.snapshot['pages/home']!)
      // readBlob returns Uint8Array (per Q9 lock — text and binary
      // both first-class). Decode UTF-8 to compare against the
      // original string.
      expect(new TextDecoder().decode(bytes)).toBe('hello')
    })

    it('round-trips binary content (Uint8Array in → Uint8Array out)', async () => {
      const h = createHistoryProvider({ storage })
      const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) // JPEG SOI marker
      const r = await h.recordRevision(input({ 'assets/hero-abc12345.jpg': original }))
      const m = await h.readRevision(r.id)
      const bytes = await h.readBlob(m.snapshot['assets/hero-abc12345.jpg']!)
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(bytes)).toEqual(Array.from(original))
    })

    it('text and identical-bytes hash to the same blob (dedup holds)', async () => {
      const h = createHistoryProvider({ storage })
      const text = 'identical content'
      const bytes = new TextEncoder().encode(text)

      const r1 = await h.recordRevision(input({ 'item-a': text }))
      const r2 = await h.recordRevision(input({ 'item-b': bytes }))

      const m1 = await h.readRevision(r1.id)
      const m2 = await h.readRevision(r2.id)
      // Same hash because the underlying bytes (UTF-8 of the text)
      // match the explicit Uint8Array.
      expect(m1.snapshot['item-a']).toBe(m2.snapshot['item-b'])
    })
  })

  describe('retention', () => {
    it('keeps only the most recent N revisions (default 50)', async () => {
      const h = createHistoryProvider({ storage, retention: 3 })
      const ids: string[] = []
      for (let i = 0; i < 5; i++) ids.push((await h.recordRevision(input({ a: `${i}` }))).id)
      const list = await h.listRevisions()
      expect(list.map(r => r.id)).toEqual([ids[4], ids[3], ids[2]])
    })

    it('evicts oldest manifests on write; new ids remain orderable after evictions', async () => {
      const h = createHistoryProvider({ storage, retention: 2 })
      const r1 = await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      const r3 = await h.recordRevision(input({ a: '3' })) // evicts r1
      expect(await storage.exists(`.gazetta/history/revisions/${r1.id}.json`)).toBe(false)
      expect(await storage.exists(`.gazetta/history/revisions/${r2.id}.json`)).toBe(true)
      // New ids don't collide with any retained or evicted id.
      const r4 = await h.recordRevision(input({ a: '4' }))
      expect(r4.id).not.toBe(r1.id)
      expect(r4.id).not.toBe(r2.id)
      expect(r4.id).not.toBe(r3.id)
      // ... and a lex-sort still matches chrono order across evictions.
      expect([r1.id, r2.id, r3.id, r4.id]).toEqual([r1.id, r2.id, r3.id, r4.id].slice().sort())
    })

    it('clamps retention <= 0 to 1 (disable via history.enabled instead)', async () => {
      const h = createHistoryProvider({ storage, retention: 0 })
      await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      const list = await h.listRevisions()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(r2.id)
    })
  })

  describe('deleteRevision', () => {
    it('removes the manifest and drops from the index', async () => {
      const h = createHistoryProvider({ storage })
      const r1 = await h.recordRevision(input({ a: '1' }))
      const r2 = await h.recordRevision(input({ a: '2' }))
      await h.deleteRevision(r1.id)
      expect(await storage.exists(`.gazetta/history/revisions/${r1.id}.json`)).toBe(false)
      const list = await h.listRevisions()
      expect(list.map(r => r.id)).toEqual([r2.id])
    })

    it('no-op for unknown id', async () => {
      const h = createHistoryProvider({ storage })
      await h.recordRevision(input({ a: '1' }))
      await h.deleteRevision('rev-9999999999999') // should not throw
      const list = await h.listRevisions()
      expect(list).toHaveLength(1)
    })
  })

  describe('rootPath option', () => {
    it('stores history under the provided path', async () => {
      const h = createHistoryProvider({ storage, rootPath: 'custom/path' })
      const r = await h.recordRevision(input({ a: '1' }))
      expect(await storage.exists('custom/path/index.json')).toBe(true)
      expect(await storage.exists(`custom/path/revisions/${r.id}.json`)).toBe(true)
    })
  })
})
