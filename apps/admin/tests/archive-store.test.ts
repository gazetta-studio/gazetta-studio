/**
 * Cut 10 MVP — archive store state-machine tests.
 *
 * Pins the locked Pinia store contract: askArchive opens the
 * archive-confirm dialog; askPurge opens purge-confirm; unarchive is
 * a one-click action with no modal; close returns to idle. Tests
 * stub `fetch` to keep the suite hermetic.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * Pinia + a fresh fetch mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useArchiveStore, type ArchiveTarget } from '../src/client/stores/archive.js'

const fetchMock = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  fetchMock.mockReset()
  // Stub global fetch — the store calls fetch directly via API_BASE.
  vi.stubGlobal('fetch', fetchMock)
})

const live: ArchiveTarget = { kind: 'page', name: 'landing', archived: false }
const archived: ArchiveTarget = { kind: 'page', name: 'old-landing', archived: true, currentAliasOf: 'home' }

describe('useArchiveStore — state machine', () => {
  it('starts in idle / hidden', () => {
    const store = useArchiveStore()
    expect(store.status).toBe('idle')
    expect(store.dialogVariant).toBe('hidden')
    expect(store.item).toBe(null)
  })

  it('askArchive transitions to archive-confirming and surfaces archive-confirm variant', () => {
    const store = useArchiveStore()
    store.askArchive(live)
    expect(store.status).toBe('archive-confirming')
    expect(store.dialogVariant).toBe('archive-confirm')
    expect(store.item).toEqual(live)
  })

  it('askPurge transitions to purge-confirming and surfaces purge-confirm variant', () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    expect(store.status).toBe('purge-confirming')
    expect(store.dialogVariant).toBe('purge-confirm')
    expect(store.item).toEqual(archived)
  })

  it('close from any state returns to idle', () => {
    const store = useArchiveStore()
    store.askArchive(live)
    expect(store.status).toBe('archive-confirming')
    store.close()
    expect(store.status).toBe('idle')
    expect(store.item).toBe(null)
  })
})

describe('useArchiveStore — confirmArchive', () => {
  it('POSTs to /archive with aliasOf and returns true on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'landing', archivedAt: '2026-05-09T00:00:00Z', aliasOf: 'home' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    const ok = await store.confirmArchive({ aliasOf: 'home' })
    expect(ok).toBe(true)
    expect(store.status).toBe('idle') // closed after success
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/pages/landing/archive')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe(JSON.stringify({ aliasOf: 'home' }))
  })

  it('POSTs without body when aliasOf is omitted (pure soft-delete)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'landing', archivedAt: '2026-05-09T00:00:00Z' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    await store.confirmArchive({})
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.body).toBeUndefined()
  })

  it('transitions to error on 409 and exposes the error message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'ARCHIVE_HAS_LIVE_REFS', message: 'live refs exist' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    const ok = await store.confirmArchive({})
    expect(ok).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toContain('409')
    expect(store.errorMessage).toContain('live refs exist')
  })
})

describe('useArchiveStore — unarchive', () => {
  it('one-click unarchive transitions to unarchiving and back to idle on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    const promise = store.unarchive(archived)
    expect(store.status).toBe('unarchiving')
    expect(store.dialogVariant).toBe('hidden') // no modal for unarchive
    const ok = await promise
    expect(ok).toBe(true)
    expect(store.status).toBe('idle')
  })

  it('surfaces error on failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'storage failure' }),
    })
    const store = useArchiveStore()
    const ok = await store.unarchive(archived)
    expect(ok).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toContain('storage failure')
  })
})

describe('useArchiveStore — confirmPurge', () => {
  it('DELETEs /purge and returns true on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    const ok = await store.confirmPurge()
    expect(ok).toBe(true)
    expect(store.status).toBe('idle')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/pages/old-landing/purge')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('appends ?force=true when force option is set', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'x' }) })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.confirmPurge({ force: true })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('?force=true')
  })

  it('transitions to purge-blocked on 409 DELETE_BLOCKED with structured arrays', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'DELETE_BLOCKED',
        aliases: [{ kind: 'page', name: 'old-landing' }],
        liveRefs: [{ kind: 'page', name: 'home' }],
      }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    const ok = await store.confirmPurge()
    expect(ok).toBe(false)
    expect(store.status).toBe('purge-blocked')
    expect(store.dialogVariant).toBe('purge-blocked')
    expect(store.blockedAliases).toEqual([{ kind: 'page', name: 'old-landing' }])
    expect(store.blockedLiveRefs).toEqual([{ kind: 'page', name: 'home' }])
  })
})

describe('useArchiveStore — Cut 12 setAlias + restoreBlocker', () => {
  it('setAlias PATCHes /alias and retries the purge', async () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    // PATCH alias success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })
    // Retry purge success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })

    const ok = await store.setAlias({ kind: 'page', name: 'old-landing' }, null)
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [patchUrl, patchInit] = fetchMock.mock.calls[0]
    expect(patchUrl).toContain('/pages/old-landing/alias')
    expect((patchInit as RequestInit).method).toBe('PATCH')
    expect((patchInit as RequestInit).body).toBe(JSON.stringify({ aliasOf: null }))
  })

  it('restoreBlocker POSTs /unarchive and retries the purge', async () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    // POST unarchive success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })
    // Retry purge success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })

    const ok = await store.restoreBlocker({ kind: 'page', name: 'old-landing' })
    expect(ok).toBe(true)
    const [unarchUrl, unarchInit] = fetchMock.mock.calls[0]
    expect(unarchUrl).toContain('/pages/old-landing/unarchive')
    expect((unarchInit as RequestInit).method).toBe('POST')
  })

  it('retryPurge after one blocker resolved still surfaces remaining blockers', async () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    // PATCH alias success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    // Retry purge — STILL BLOCKED (remaining liveRef)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'DELETE_BLOCKED', aliases: [], liveRefs: [{ kind: 'page', name: 'still-here' }] }),
    })

    const ok = await store.setAlias({ kind: 'page', name: 'old-landing' }, null)
    expect(ok).toBe(false)
    expect(store.status).toBe('purge-blocked')
    expect(store.blockedAliases).toEqual([])
    expect(store.blockedLiveRefs).toEqual([{ kind: 'page', name: 'still-here' }])
  })
})
