/**
 * The CLI login store (design-agent-access.md Q16, Q21): codes expire
 * after 10 minutes and work once, also across two admin instances
 * sharing storage; grants keep only a hash of their secret.
 */
import { describe, expect, it } from 'vitest'
import { createCliLoginStore, LOGIN_TTL_MS, normalizeLoginCode } from '../src/auth/cli-login-store.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const alice = { id: 'alice', email: 'alice@example.com', role: 'editor', trustMode: 'forwarded-user' }

function clock(start = Date.parse('2026-11-01T12:00:00Z')) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('CLI login store', () => {
  it('starts a pending login with a typed-friendly code', async () => {
    const store = createCliLoginStore(memoryStorage())
    const { code, pollSecret } = await store.start({ machine: 'laptop', ip: '203.0.113.7' })
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(normalizeLoginCode(code.toLowerCase().replace('-', ''))).toBe(code)
    const login = await store.get(code)
    expect(login).toMatchObject({ machine: 'laptop', ip: '203.0.113.7', state: 'pending' })
    expect(JSON.stringify(login)).not.toContain(pollSecret)
  })

  it('answers pending until approved, then a grant once', async () => {
    const storage = memoryStorage()
    const store = createCliLoginStore(storage)
    const { code, pollSecret } = await store.start({ machine: 'laptop' })
    expect(await store.redeem(code, pollSecret)).toEqual({ status: 'pending' })
    expect((await store.approve(code, alice)).status).toBe('ok')
    const first = await store.redeem(code, pollSecret)
    expect(first.status).toBe('approved')
    if (first.status !== 'approved') return
    expect(first.grant.person).toEqual(alice)
    expect(await store.redeem(code, pollSecret)).toEqual({ status: 'redeemed' })
    // The grant file keeps a hash, not the secret.
    const stored = [...storage.dump().values()].map(v => Buffer.from(v).toString()).join('\n')
    expect(stored).not.toContain(first.grantSecret.split('.')[1])
    expect((await store.grantFor(first.grantSecret))?.grantId).toBe(first.grant.grantId)
  })

  it('redeems a code once across two instances racing on one storage', async () => {
    const storage = memoryStorage()
    const a = createCliLoginStore(storage)
    const b = createCliLoginStore(storage)
    const { code, pollSecret } = await a.start({ machine: 'laptop' })
    await b.approve(code, alice)
    const results = await Promise.all([a.redeem(code, pollSecret), b.redeem(code, pollSecret)])
    expect(results.map(r => r.status).sort()).toEqual(['approved', 'redeemed'])
  })

  it('treats a wrong poll secret as an unknown code', async () => {
    const store = createCliLoginStore(memoryStorage())
    const { code } = await store.start({ machine: 'laptop' })
    await store.approve(code, alice)
    expect(await store.redeem(code, 'not-the-secret')).toEqual({ status: 'not-found' })
  })

  it('expires a code after 10 minutes, for approving and redeeming', async () => {
    const c = clock()
    const store = createCliLoginStore(memoryStorage(), c.now)
    const { code, pollSecret } = await store.start({ machine: 'laptop' })
    c.advance(LOGIN_TTL_MS)
    expect((await store.approve(code, alice)).status).toBe('expired')
    expect(await store.redeem(code, pollSecret)).toEqual({ status: 'expired' })
  })

  it('answers denied once the person denies, and a decided code cannot be decided again', async () => {
    const store = createCliLoginStore(memoryStorage())
    const { code, pollSecret } = await store.start({ machine: 'laptop' })
    expect((await store.deny(code)).status).toBe('ok')
    expect((await store.approve(code, alice)).status).toBe('decided')
    expect(await store.redeem(code, pollSecret)).toEqual({ status: 'denied' })
  })

  it('revokes only the person’s own grant, after which its secret stops working', async () => {
    const store = createCliLoginStore(memoryStorage())
    const { code, pollSecret } = await store.start({ machine: 'laptop' })
    await store.approve(code, alice)
    const r = await store.redeem(code, pollSecret)
    if (r.status !== 'approved') throw new Error('expected a grant')
    expect(await store.revoke(r.grant.grantId, 'bob')).toBe('not-found')
    expect(await store.revoke(r.grant.grantId, 'alice')).toBe('revoked')
    expect(await store.grantFor(r.grantSecret)).toBeNull()
  })

  it('refuses a grant secret with the right id but the wrong secret', async () => {
    const store = createCliLoginStore(memoryStorage())
    const { code, pollSecret } = await store.start({ machine: 'laptop' })
    await store.approve(code, alice)
    const r = await store.redeem(code, pollSecret)
    if (r.status !== 'approved') throw new Error('expected a grant')
    expect(await store.grantFor(`${r.grant.grantId}.guess`)).toBeNull()
    expect(await store.grantFor('../../pages/home.x')).toBeNull()
  })
})
