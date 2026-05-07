/**
 * Cut 4 tests: cloudflare-access trust mode + JWT verification.
 *
 * Strategy: avoid HTTP mocking (msw) by injecting a custom
 * `jwksFactory` that returns a synchronous local key resolver.
 * jose's `jwtVerify` accepts any `JWTVerifyGetKey` shape so we
 * verify against an in-process key pair generated per test.
 *
 * The provider's contract:
 *   - Missing JWT → null (anonymous, middleware → 401)
 *   - Header takes precedence over CF_Authorization cookie
 *   - Valid signature + matching iss → returns Principal with id from sub
 *   - Invalid signature → AuthenticationError
 *   - Expired token → AuthenticationError
 *   - Wrong issuer → AuthenticationError
 *   - aud mismatch (when configured) → AuthenticationError
 *   - Constructor rejects malformed teamDomain
 */
import { describe, expect, it } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import {
  AuthConfigurationError,
  AuthConfigSchema,
  AuthenticationError,
  createCloudflareAccessAuthProvider,
} from '../src/auth/index.js'
import type { AuthRequest } from '../src/auth/provider.js'

/**
 * Build an in-process key pair + JWKS factory + signing helper.
 * Each test calls `setup()` to get a fresh key pair, signs tokens
 * with the private key, and the provider verifies via the matching
 * factory.
 */
async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  jwk.alg = 'RS256'
  jwk.kid = 'test-key-1'

  const jwksFactory: (jwksUrl: URL) => JWTVerifyGetKey = () => {
    // jose's getKey resolver — returns the public key for any JWT
    // header (we only have one key in this test).
    return async () => publicKey
  }

  async function sign(claims: JWTPayload, opts: { exp?: number; iss?: string; aud?: string } = {}): Promise<string> {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
    if (opts.iss) jwt.setIssuer(opts.iss)
    if (opts.aud) jwt.setAudience(opts.aud)
    return jwt.sign(privateKey)
  }

  return { publicKey, privateKey, jwk, jwksFactory, sign }
}

function makeReq(headers: Record<string, string> = {}): AuthRequest {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(headers)) map.set(k.toLowerCase(), v)
  return { headers: map }
}

describe('AuthConfigSchema — cloudflare-access (Cut 4)', () => {
  it('accepts a valid teamDomain', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'cloudflare-access', teamDomain: 'acme' })
    expect(r.success).toBe(true)
  })

  it('accepts teamDomain with hyphens', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'cloudflare-access', teamDomain: 'my-team' })
    expect(r.success).toBe(true)
  })

  it('rejects teamDomain with uppercase', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'cloudflare-access', teamDomain: 'Acme' })
    expect(r.success).toBe(false)
  })

  it('rejects teamDomain starting with hyphen', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'cloudflare-access', teamDomain: '-acme' })
    expect(r.success).toBe(false)
  })

  it('rejects missing teamDomain', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'cloudflare-access' })
    expect(r.success).toBe(false)
  })

  it('accepts optional audience', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'cloudflare-access',
      teamDomain: 'acme',
      audience: 'https://admin.example.com',
    })
    expect(r.success).toBe(true)
  })
})

describe('createCloudflareAccessAuthProvider construction (Cut 4)', () => {
  it('throws AuthConfigurationError on empty teamDomain', () => {
    expect(() => createCloudflareAccessAuthProvider({ teamDomain: '' })).toThrow(AuthConfigurationError)
  })

  it('throws AuthConfigurationError on uppercase teamDomain', () => {
    expect(() => createCloudflareAccessAuthProvider({ teamDomain: 'Acme' })).toThrow(AuthConfigurationError)
  })

  it('throws on teamDomain with invalid characters', () => {
    expect(() => createCloudflareAccessAuthProvider({ teamDomain: 'acme.bad' })).toThrow(AuthConfigurationError)
    expect(() => createCloudflareAccessAuthProvider({ teamDomain: 'acme/foo' })).toThrow(AuthConfigurationError)
  })

  it('declares trust mode cloudflare-access', () => {
    const provider = createCloudflareAccessAuthProvider({
      teamDomain: 'acme',
      jwksFactory: () => async () => null as never,
    })
    expect(provider.trustMode).toBe('cloudflare-access')
  })
})

describe('createCloudflareAccessAuthProvider verification (Cut 4)', () => {
  it('returns null when no token is present (anonymous request)', async () => {
    const { jwksFactory } = await setup()
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const principal = await provider.extractPrincipal(makeReq())
    expect(principal).toBeNull()
  })

  it('returns Principal for a valid signed token (header)', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign(
      { sub: 'user-123', email: 'alice@example.com' },
      { iss: 'https://acme.cloudflareaccess.com' },
    )
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const principal = await provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': token }))
    expect(principal).not.toBeNull()
    expect(principal!.id).toBe('user-123')
    expect(principal!.email).toBe('alice@example.com')
    expect(principal!.trustMode).toBe('cloudflare-access')
    expect(principal!.role).toBe('editor') // default until Cut 6
  })

  it('extracts token from CF_Authorization cookie when header is absent', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign({ sub: 'user-456' }, { iss: 'https://acme.cloudflareaccess.com' })
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const principal = await provider.extractPrincipal(makeReq({ Cookie: `CF_Authorization=${token}; other=value` }))
    expect(principal!.id).toBe('user-456')
  })

  it('header takes precedence over cookie', async () => {
    const { jwksFactory, sign } = await setup()
    const headerToken = await sign({ sub: 'header-user' }, { iss: 'https://acme.cloudflareaccess.com' })
    const cookieToken = await sign({ sub: 'cookie-user' }, { iss: 'https://acme.cloudflareaccess.com' })
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const principal = await provider.extractPrincipal(
      makeReq({ 'Cf-Access-Jwt-Assertion': headerToken, Cookie: `CF_Authorization=${cookieToken}` }),
    )
    expect(principal!.id).toBe('header-user')
  })

  it('rejects a token with the wrong issuer', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign({ sub: 'user-123' }, { iss: 'https://attacker.cloudflareaccess.com' })
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    await expect(provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': token }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('rejects an expired token', async () => {
    const s = await setup()
    // Sign a token with an explicit past `exp` — we want the
    // expiry check to fail, not the signature.
    const nowSec = Math.floor(Date.now() / 1000)
    const expiredToken = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(nowSec - 10000)
      .setExpirationTime(nowSec - 1000)
      .setIssuer('https://acme.cloudflareaccess.com')
      .sign(s.privateKey)
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory: s.jwksFactory })
    await expect(
      provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': expiredToken })),
    ).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('rejects a token signed by a different key (signature regression)', async () => {
    // Sign with key A; verify against key B. The whole point of
    // JWT verification is rejecting forged signatures.
    const setupA = await setup()
    const setupB = await setup()
    const forgedToken = await setupA.sign({ sub: 'admin' }, { iss: 'https://acme.cloudflareaccess.com' })
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory: setupB.jwksFactory })
    await expect(provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': forgedToken }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('rejects a token with mismatched audience when audience is configured', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign(
      { sub: 'user' },
      { iss: 'https://acme.cloudflareaccess.com', aud: 'https://other-app.example.com' },
    )
    const provider = createCloudflareAccessAuthProvider({
      teamDomain: 'acme',
      audience: 'https://admin.example.com',
      jwksFactory,
    })
    await expect(provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': token }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('accepts a token with matching audience', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign(
      { sub: 'user' },
      { iss: 'https://acme.cloudflareaccess.com', aud: 'https://admin.example.com' },
    )
    const provider = createCloudflareAccessAuthProvider({
      teamDomain: 'acme',
      audience: 'https://admin.example.com',
      jwksFactory,
    })
    const principal = await provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': token }))
    expect(principal!.id).toBe('user')
  })

  it('falls back to identity_nonce when sub is absent', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign({ identity_nonce: 'nonce-xyz' }, { iss: 'https://acme.cloudflareaccess.com' })
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const principal = await provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': token }))
    expect(principal!.id).toBe('nonce-xyz')
  })

  it('respects custom defaultRole', async () => {
    const { jwksFactory, sign } = await setup()
    const token = await sign({ sub: 'user' }, { iss: 'https://acme.cloudflareaccess.com' })
    const provider = createCloudflareAccessAuthProvider({
      teamDomain: 'acme',
      defaultRole: 'viewer',
      jwksFactory,
    })
    const principal = await provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': token }))
    expect(principal!.role).toBe('viewer')
  })

  it('rejects garbage token (not a JWT)', async () => {
    const { jwksFactory } = await setup()
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    await expect(
      provider.extractPrincipal(makeReq({ 'Cf-Access-Jwt-Assertion': 'not-a-jwt-at-all' })),
    ).rejects.toBeInstanceOf(AuthenticationError)
  })
})
