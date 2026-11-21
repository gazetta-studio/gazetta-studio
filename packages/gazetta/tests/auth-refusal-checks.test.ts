/**
 * Which check an identity provider's refusal came from (#1262,
 * design-audit.md "Recording scope (v1)"): the audit log's `sign-in`
 * rows say whether a request was refused for its credentials, an
 * untrusted proxy, a verification service that couldn't be reached
 * (`unverifiable`) or a verified user matching no role.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, SignJWT, errors as joseErrors, type JWTVerifyGetKey } from 'jose'
import {
  AuthenticationError,
  createAzureEasyAuthProvider,
  createCloudflareAccessAuthProvider,
  createForwardedUserAuthProvider,
} from '../src/auth/index.js'
import { createTailscaleAuthProvider } from '../src/auth/providers/tailscale.js'
import { defaultJwksFactory } from '../src/auth/providers/aws-cognito.js'
import type { AuthRequest } from '../src/auth/provider.js'

function req(headers: Record<string, string>, peerAddress?: string): AuthRequest {
  return { headers: new Map(Object.entries(headers)), peerAddress, method: 'POST', url: 'http://x/api/v1/pages' }
}

async function refusal(p: Promise<unknown>): Promise<AuthenticationError> {
  const err = await p.then(
    () => null,
    e => e,
  )
  expect(err).toBeInstanceOf(AuthenticationError)
  return err as AuthenticationError
}

afterEach(() => vi.unstubAllGlobals())

describe('AuthenticationError check', () => {
  it('defaults to credentials when the provider names no check', () => {
    const err = new AuthenticationError('bad token')
    expect(err.check).toBe('credentials')
    expect(err.user).toBeUndefined()
  })
})

describe('forwarded-user refusals', () => {
  const provider = createForwardedUserAuthProvider({
    trust: 'forwarded-user',
    trustedProxies: ['10.0.0.0/8'],
    roleMapping: { claim: 'groups', map: { admins: 'admin' } },
  } as never)

  it('a request from outside trustedProxies is a proxy refusal', async () => {
    const err = await refusal(provider.extractPrincipal(req({ 'x-forwarded-user': 'alice' }, '203.0.113.9')))
    expect(err.check).toBe('proxy')
    expect(err.user).toBeUndefined()
  })

  it('a verified user matching no role is a no-role refusal naming the user', async () => {
    const err = await refusal(
      provider.extractPrincipal(
        req(
          { 'x-forwarded-user': 'dave', 'x-forwarded-email': 'dave@example.com', 'x-forwarded-groups': 'x' },
          '10.0.0.5',
        ),
      ),
    )
    expect(err.check).toBe('no-role')
    expect(err.user).toEqual({ id: 'dave', email: 'dave@example.com' })
  })
})

describe('tailscale refusals', () => {
  it('identity headers on a connection not from the local proxy are a proxy refusal', async () => {
    const provider = createTailscaleAuthProvider({ trust: 'tailscale' } as never)
    const err = await refusal(provider.extractPrincipal(req({ 'tailscale-user-login': 'a@b.ts.net' }, '203.0.113.9')))
    expect(err.check).toBe('proxy')
  })
})

describe('azure-easy-auth refusals', () => {
  it('a malformed principal header is a credentials refusal', async () => {
    const provider = createAzureEasyAuthProvider({ trust: 'azure-easy-auth' } as never)
    const err = await refusal(provider.extractPrincipal(req({ 'x-ms-client-principal': '!!notbase64json' })))
    expect(err.check).toBe('credentials')
  })

  it('a principal matching no role is a no-role refusal naming the user', async () => {
    const provider = createAzureEasyAuthProvider({
      trust: 'azure-easy-auth',
      roleMapping: { claim: 'groups', map: { admins: 'admin' } },
    } as never)
    const encoded = Buffer.from(
      JSON.stringify({
        claims: [{ typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', val: 'u-1' }],
      }),
    ).toString('base64')
    const err = await refusal(provider.extractPrincipal(req({ 'x-ms-client-principal': encoded })))
    expect(err.check).toBe('no-role')
    expect(err.user?.id).toBe('u-1')
  })
})

describe('cloudflare-access refusals', () => {
  async function signed() {
    const { privateKey } = await generateKeyPair('RS256')
    return new SignJWT({ sub: 'alice' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://acme.cloudflareaccess.com')
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  it('a key endpoint that times out is unverifiable, not a credentials refusal', async () => {
    const jwksFactory = (): JWTVerifyGetKey => async () => {
      throw new joseErrors.JWKSTimeout()
    }
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const err = await refusal(provider.extractPrincipal(req({ 'cf-access-jwt-assertion': await signed() })))
    expect(err.check).toBe('unverifiable')
  })

  it('a key endpoint that answers with an error is unverifiable', async () => {
    const jwksFactory = (): JWTVerifyGetKey => async () => {
      throw new joseErrors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response')
    }
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const err = await refusal(provider.extractPrincipal(req({ 'cf-access-jwt-assertion': await signed() })))
    expect(err.check).toBe('unverifiable')
  })

  it('a key endpoint that can not be reached is unverifiable', async () => {
    const jwksFactory = (): JWTVerifyGetKey => async () => {
      throw new TypeError('fetch failed')
    }
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const err = await refusal(provider.extractPrincipal(req({ 'cf-access-jwt-assertion': await signed() })))
    expect(err.check).toBe('unverifiable')
  })

  it('an unknown key id is a credentials refusal', async () => {
    const jwksFactory = (): JWTVerifyGetKey => async () => {
      throw new joseErrors.JWKSNoMatchingKey()
    }
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const err = await refusal(provider.extractPrincipal(req({ 'cf-access-jwt-assertion': await signed() })))
    expect(err.check).toBe('credentials')
  })

  it('a token signed by another key is a credentials refusal', async () => {
    const other = await generateKeyPair('RS256')
    const jwksFactory = (): JWTVerifyGetKey => async () => other.publicKey
    const provider = createCloudflareAccessAuthProvider({ teamDomain: 'acme', jwksFactory })
    const err = await refusal(provider.extractPrincipal(req({ 'cf-access-jwt-assertion': await signed() })))
    expect(err.check).toBe('credentials')
  })
})

describe('aws-cognito key endpoint', () => {
  const header = { kid: 'k1', alg: 'ES256' }

  it('a server error from the public-keys endpoint is unverifiable', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    const err = await refusal(defaultJwksFactory('us-east-1')(header as never, {} as never) as Promise<unknown>)
    expect(err.check).toBe('unverifiable')
  })

  it('an endpoint that can not be reached is unverifiable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const err = await refusal(defaultJwksFactory('us-east-1')(header as never, {} as never) as Promise<unknown>)
    expect(err.check).toBe('unverifiable')
  })

  it('a connection that fails while reading the key is unverifiable', async () => {
    const body = new ReadableStream({
      pull() {
        throw new TypeError('terminated')
      },
    })
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }))
    const err = await refusal(defaultJwksFactory('us-east-1')(header as never, {} as never) as Promise<unknown>)
    expect(err.check).toBe('unverifiable')
  })

  it('a key id the endpoint does not know is a credentials refusal', async () => {
    vi.stubGlobal('fetch', async () => new Response('no such key', { status: 404 }))
    const err = await refusal(defaultJwksFactory('us-east-1')(header as never, {} as never) as Promise<unknown>)
    expect(err.check).toBe('credentials')
  })
})
