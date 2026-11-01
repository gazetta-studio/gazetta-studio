/**
 * Gazetta token signing and verification (design-agent-access.md Q16,
 * Q25, Q27): RS256, 15 minutes, 60 seconds of clock leeway either way,
 * and a previous key accepted after rotation.
 */
import { exportPKCS8 } from 'jose'
import { describe, expect, it } from 'vitest'
import { generateSigningKeys, signingKeysFromEnv, type SigningKeys } from '../src/auth/tokens/keys.js'
import { issueToken, TOKEN_LIFETIME_SECONDS, TokenRejectedError, verifyToken } from '../src/auth/tokens/token.js'

const subject = { id: 'alice', email: 'alice@example.com', role: 'editor', trustMode: 'forwarded-user', grantId: 'g1' }
const T0 = Date.parse('2026-11-01T12:00:00Z')

async function rejected(keys: SigningKeys, token: string, now: number): Promise<string> {
  const err = await verifyToken(keys, token, now).catch(e => e)
  expect(err).toBeInstanceOf(TokenRejectedError)
  return (err as Error).message
}

describe('Gazetta tokens', () => {
  it('round-trips the subject and lasts 15 minutes', async () => {
    const keys = await generateSigningKeys()
    const issued = await issueToken(keys, subject, T0)
    expect(issued.expiresAt).toBe(T0 / 1000 + TOKEN_LIFETIME_SECONDS)
    const verified = await verifyToken(keys, issued.token, T0)
    expect(verified).toEqual({ ...subject, tokenId: issued.tokenId, expiresAt: issued.expiresAt })
  })

  it('refuses a token signed with another key', async () => {
    const token = (await issueToken(await generateSigningKeys(), subject, T0)).token
    expect(await rejected(await generateSigningKeys(), token, T0)).toBe('Token is not valid')
  })

  it('accepts a token 59 seconds past expiry and refuses it 61 seconds past', async () => {
    const keys = await generateSigningKeys()
    const { token, expiresAt } = await issueToken(keys, subject, T0)
    await expect(verifyToken(keys, token, (expiresAt + 59) * 1000)).resolves.toMatchObject({ id: 'alice' })
    expect(await rejected(keys, token, (expiresAt + 61) * 1000)).toBe('Token has expired')
  })

  it('accepts a token issued up to 60 seconds ahead of this clock, not more', async () => {
    const keys = await generateSigningKeys()
    const { token } = await issueToken(keys, subject, T0)
    await expect(verifyToken(keys, token, T0 - 59_000)).resolves.toMatchObject({ id: 'alice' })
    expect(await rejected(keys, token, T0 - 61_000)).toBe('Token is not valid')
  })

  it('refuses a tampered token', async () => {
    const keys = await generateSigningKeys()
    const { token } = await issueToken(keys, subject, T0)
    const [h, p, s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'admin' }))
    expect(await rejected(keys, `${h}.${forged.toString('base64url')}.${s}`, T0)).toBe('Token is not valid')
  })

  it('after rotation, accepts tokens signed with the previous key and signs with the new one', async () => {
    const old = await generateSigningKeys()
    const fresh = await generateSigningKeys()
    const pem = async (k: SigningKeys) => exportPKCS8(k.current.privateKey)
    const rotated = await signingKeysFromEnv({
      GAZETTA_SIGNING_KEY: await pem(fresh),
      GAZETTA_SIGNING_KEY_PREVIOUS: await pem(old),
    })
    const oldToken = (await issueToken(old, subject, T0)).token
    await expect(verifyToken(rotated!, oldToken, T0)).resolves.toMatchObject({ id: 'alice' })
    const newToken = (await issueToken(rotated!, subject, T0)).token
    await expect(verifyToken(fresh, newToken, T0)).resolves.toMatchObject({ id: 'alice' })
    // Once the previous key is dropped, its tokens stop working.
    const after = await signingKeysFromEnv({ GAZETTA_SIGNING_KEY: await pem(fresh) })
    expect(await rejected(after!, oldToken, T0)).toBe('Token is not valid')
  })

  it('reads no key when GAZETTA_SIGNING_KEY is unset, and refuses one that is not a key', async () => {
    expect(await signingKeysFromEnv({})).toBeNull()
    await expect(signingKeysFromEnv({ GAZETTA_SIGNING_KEY: 'not a key' })).rejects.toThrow(/GAZETTA_SIGNING_KEY is not/)
  })

  it('accepts a PEM stored on one line with \\n escapes', async () => {
    const pem = await exportPKCS8((await generateSigningKeys()).current.privateKey)
    const keys = await signingKeysFromEnv({ GAZETTA_SIGNING_KEY: pem.replace(/\n/g, '\\n') })
    expect(keys?.current.kid).toMatch(/^[\w-]{43}$/)
  })
})
