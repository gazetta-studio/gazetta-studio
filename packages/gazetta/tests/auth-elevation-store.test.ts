/**
 * Elevation records (design-agent-access.md Q17): a fixed window from
 * approval, one scope, ended at once by removing the record.
 */
import { describe, expect, it } from 'vitest'
import { createElevationStore, elevationScopeFor } from '../src/auth/elevation-store.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function clock(start = Date.parse('2026-11-01T12:00:00Z')) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const base = { grantId: 'g1', personId: 'alice', capabilities: ['publish:non-production', 'delete:pages'], minutes: 15 }

describe('elevation records', () => {
  it('end at approval plus the window, and using one never moves that', async () => {
    const c = clock()
    const store = createElevationStore(memoryStorage(), c.now)
    const e = await store.create({ ...base, scope: 'non-production' })
    expect(Date.parse(e.endsAt) - Date.parse(e.approvedAt)).toBe(15 * 60_000)
    for (const minute of [1, 5, 14]) {
      c.advance(60_000 * (minute === 1 ? 1 : minute === 5 ? 4 : 9))
      expect(await store.covers('g1', 'non-production', 'publish:non-production')).toBe(true)
    }
    expect((await store.get(e.elevationId))?.endsAt).toBe(e.endsAt)
    c.advance(60_000)
    expect(await store.covers('g1', 'non-production', 'publish:non-production')).toBe(false)
  })

  it('never outlast their grant', async () => {
    const c = clock()
    const store = createElevationStore(memoryStorage(), c.now)
    const e = await store.create({ ...base, scope: 'non-production', notAfter: c.now() + 60_000 })
    expect(Date.parse(e.endsAt)).toBe(c.now() + 60_000)
  })

  it('cover only their scope and the capabilities approved', async () => {
    const store = createElevationStore(memoryStorage())
    await store.create({ ...base, scope: 'non-production' })
    expect(await store.covers('g1', 'production', 'delete:pages')).toBe(false)
    expect(await store.covers('g1', 'non-production', 'restore:history')).toBe(false)
    expect(await store.covers('g2', 'non-production', 'delete:pages')).toBe(false)
  })

  it('end at once, one or all of a grant', async () => {
    const store = createElevationStore(memoryStorage())
    const one = await store.create({ ...base, scope: 'non-production' })
    await store.create({ ...base, scope: 'production' })
    await store.end(one.elevationId)
    expect(await store.covers('g1', 'non-production', 'delete:pages')).toBe(false)
    expect(await store.covers('g1', 'production', 'delete:pages')).toBe(true)
    await store.endAll('g1')
    expect(await store.covers('g1', 'production', 'delete:pages')).toBe(false)
  })
})

describe('elevationScopeFor', () => {
  it.each([
    ['publish:production', 'staging', 'production'],
    ['publish:non-production', 'production', 'non-production'],
    ['delete:pages', 'production', 'production'],
    ['delete:pages', 'local', 'non-production'],
    ['restore:history', undefined, 'non-production'],
  ] as const)('%s on %s → %s', (cap, env, scope) => expect(elevationScopeFor(cap, env)).toBe(scope))
})
