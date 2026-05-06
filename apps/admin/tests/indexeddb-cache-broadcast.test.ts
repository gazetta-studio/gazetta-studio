/**
 * Cross-tab invalidation propagation per `design-offline.md`'s
 * "Storage isolation — Cross-tab sync via native BroadcastChannel."
 *
 * Two `IndexedDBCache` providers built against the same database
 * name simulate two browser tabs in the same origin. An invalidate
 * in tab A fires tab B's local subscribers via the channel; the loop
 * guard (instance-ID check) prevents tab A's own subscribers from
 * double-firing on the rebroadcast.
 *
 * jsdom + fake-indexeddb provides a working BroadcastChannel within
 * the test realm — separate channels with the same name communicate,
 * matching real-browser semantics. fake-indexeddb's `auto` import
 * also covers the storage layer.
 *
 * Each test uses a unique `dbName` so the BroadcastChannel name
 * (`gazetta-cache:{dbName}`) is also unique — prevents cross-test
 * contamination on the channel.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AdminCache, InvalidationEvent } from 'gazetta'
import { createIndexedDBCache } from '../src/client/cache/indexeddb-cache.js'

type DisposableCache = AdminCache & { close(): void }

/** Wait until `predicate` is true OR a deadline elapses. Cross-tab
 *  message delivery is async (microtask-queued); we can't sync-assert. */
async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for cross-tab message')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('IndexedDBCache cross-tab BroadcastChannel propagation', () => {
  let counter = 0
  const opened: DisposableCache[] = []

  afterEach(() => {
    for (const cache of opened.splice(0)) cache.close()
  })

  async function makePeerPair(dbName: string): Promise<[DisposableCache, DisposableCache]> {
    // Distinct instance IDs so the loop guard can tell them apart.
    const tabA = (await createIndexedDBCache({ dbName, instance: 'tab-a' })) as DisposableCache
    const tabB = (await createIndexedDBCache({ dbName, instance: 'tab-b' })) as DisposableCache
    opened.push(tabA, tabB)
    return [tabA, tabB]
  }

  it('invalidate in tab A fires tab B subscribers', async () => {
    const [tabA, tabB] = await makePeerPair(`gazetta-bc-${++counter}`)

    const eventsOnB: InvalidationEvent[] = []
    tabB.subscribe(event => eventsOnB.push(event))

    await tabA.set('shared-key', 'value')
    await tabA.invalidate('shared-key')

    await waitFor(() => eventsOnB.length > 0)
    expect(eventsOnB[0].prefix).toBe('shared-key')
    expect(eventsOnB[0].source.instance).toBe('tab-a')
  })

  it('invalidatePrefix in tab A fires tab B subscribers with the prefix', async () => {
    const [tabA, tabB] = await makePeerPair(`gazetta-bc-${++counter}`)

    const eventsOnB: InvalidationEvent[] = []
    tabB.subscribe(event => eventsOnB.push(event))

    await tabA.set('pages:home', 'h')
    await tabA.set('pages:about', 'a')
    await tabA.invalidatePrefix('pages:')

    await waitFor(() => eventsOnB.length > 0)
    expect(eventsOnB.some(e => e.prefix === 'pages:' && e.source.instance === 'tab-a')).toBe(true)
  })

  it('loop guard: tab A own subscribers fire ONCE per invalidation, not twice', async () => {
    // Without the instance-ID check in onmessage, tab A's own
    // BroadcastChannel listener would receive the rebroadcast and
    // re-fire local subscribers. This test pins the guard.
    const [tabA] = await makePeerPair(`gazetta-bc-${++counter}`)

    const eventsOnA: InvalidationEvent[] = []
    tabA.subscribe(event => eventsOnA.push(event))

    await tabA.invalidatePrefix('pages:')
    // Give the channel a tick to deliver any rebroadcast that would
    // double-fire if the guard were missing.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(eventsOnA.length).toBe(1)
    expect(eventsOnA[0].source.instance).toBe('tab-a')
  })

  it('invalidations on different dbNames do NOT cross-talk', async () => {
    // Two databases in the same origin must have isolated channels.
    // The channel name is suffixed by `dbName`, so two providers on
    // different DB names won't see each other's events.
    const [tabA] = await makePeerPair(`gazetta-bc-${++counter}-alpha`)
    const [tabB] = await makePeerPair(`gazetta-bc-${++counter}-beta`)

    const eventsOnB: InvalidationEvent[] = []
    tabB.subscribe(event => eventsOnB.push(event))

    await tabA.invalidatePrefix('pages:')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(eventsOnB.length).toBe(0)
  })

  it('subscribe disposer stops cross-tab events', async () => {
    const [tabA, tabB] = await makePeerPair(`gazetta-bc-${++counter}`)

    const eventsOnB: InvalidationEvent[] = []
    const dispose = tabB.subscribe(event => eventsOnB.push(event))

    await tabA.invalidatePrefix('pages:')
    await waitFor(() => eventsOnB.length > 0)
    expect(eventsOnB.length).toBe(1)

    dispose()
    eventsOnB.length = 0
    await tabA.invalidatePrefix('fragments:')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(eventsOnB.length).toBe(0)
  })
})
