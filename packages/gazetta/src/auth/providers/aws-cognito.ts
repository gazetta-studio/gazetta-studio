/**
 * `aws-cognito` trust mode — AWS Application Load Balancer fronting
 * the admin with Cognito user pool authentication. ALB injects a
 * signed JWT in the `x-amzn-oidc-data` header containing the
 * authenticated user's claims.
 *
 * # Why JWT verification (just like cloudflare-access)
 *
 * The ALB-issued token is signed with AWS's per-region key. Verifying
 * the signature is the security contract — without it, anyone behind
 * the LB or with header-injection access can forge identity.
 *
 * # JWKS endpoint shape
 *
 * AWS publishes the verification keys at:
 *
 *     https://public-keys.auth.elb.{region}.amazonaws.com/{kid}
 *
 * Unlike Cloudflare's single-JWKS endpoint, AWS's endpoint is keyed
 * by the JWT header's `kid`. jose's `createRemoteJWKSet` doesn't fit
 * this shape; we wire a custom `JWTVerifyGetKey` that fetches the
 * specific kid. The `jwksFactory` injection point makes this pluggable
 * for tests.
 *
 * # SOLID lenses
 *
 *   - SRP: same as cloudflare-access — JWT verification only.
 *   - LSP: same `AuthIdentityProvider` shape.
 *   - DIP: jwksFactory injection point lets tests run without HTTP.
 */
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { Principal } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { AuthenticationError, AuthConfigurationError } from '../errors.js'

export interface AwsCognitoConfig {
  /**
   * AWS region the ALB runs in. Required to construct the JWKS URL
   * (`public-keys.auth.elb.{region}.amazonaws.com`).
   */
  region: string
  /**
   * Optional `aud` claim — Cognito user-pool app client id. Setting
   * this prevents token replay across other Cognito-protected apps
   * sharing the same user pool.
   */
  audience?: string
  /** Optional default role until Cut 6's role-resolver wires up. */
  defaultRole?: string
  /**
   * Internal: factory for the JWKS verifier. Tests inject a stub.
   * Production builds a fetch-based key resolver per AWS's
   * keyed-by-kid endpoint shape.
   */
  jwksFactory?: (region: string) => JWTVerifyGetKey
}

interface CognitoClaims extends JWTPayload {
  email?: string
  username?: string
  /** Cognito user-pool group claim. */
  'cognito:groups'?: string[]
}

/**
 * Default JWKS factory — fetches AWS's per-kid public key. Each
 * verification call may hit a different kid; the resolver caches
 * downloaded keys to keep verification fast under steady load.
 *
 * Operators may want to override this with a `createRemoteJWKSet`
 * variant if they front Cognito directly (without ALB) — that's
 * outside Cut 5's scope; the injection point keeps it open.
 */
function defaultJwksFactory(region: string): JWTVerifyGetKey {
  const cache = new Map<string, CryptoKey>()
  return async (header: { kid?: string; alg?: string }) => {
    if (!header.kid) {
      throw new AuthenticationError('AWS Cognito JWT has no kid in header')
    }
    const cached = cache.get(header.kid)
    if (cached) return cached
    const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(header.kid)}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new AuthenticationError(`AWS public-keys endpoint returned ${res.status} for kid ${header.kid}`)
    }
    const pem = await res.text()
    // Defer to Web Crypto's importKey via jose — actually jose
    // accepts CryptoKey directly. We use Node's crypto subtle to
    // import the PEM. This works in Node 22+ which has full WebCrypto.
    const subtle = (globalThis.crypto ?? require('node:crypto').webcrypto).subtle
    const key = await subtle.importKey(
      'spki',
      pemToDer(pem),
      { name: 'ECDSA', namedCurve: header.alg === 'ES512' ? 'P-521' : 'P-256' },
      false,
      ['verify'],
    )
    cache.set(header.kid, key)
    return key
  }
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const bin = Buffer.from(body, 'base64')
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
}

export function createAwsCognitoAuthProvider(config: AwsCognitoConfig): AuthIdentityProvider {
  if (!config.region || config.region.length === 0) {
    throw new AuthConfigurationError('aws-cognito trust mode requires region (e.g. "us-east-1")')
  }
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(config.region)) {
    throw new AuthConfigurationError(
      `Invalid region "${config.region}": expected AWS region format like "us-east-1" or "eu-west-2"`,
    )
  }

  const jwks = (config.jwksFactory ?? defaultJwksFactory)(config.region)
  const defaultRole = config.defaultRole ?? 'editor'

  return {
    trustMode: 'aws-cognito',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      const token = req.headers.get('x-amzn-oidc-data')
      if (!token) return null

      let payload: CognitoClaims
      try {
        const result = await jwtVerify<CognitoClaims>(token, jwks, {
          audience: config.audience,
        })
        payload = result.payload
      } catch (err) {
        throw new AuthenticationError(`AWS Cognito JWT verification failed: ${(err as Error).message}`)
      }

      const id = payload.sub ?? payload.username
      if (!id) {
        throw new AuthenticationError('AWS Cognito JWT has no sub or username claim')
      }

      return {
        id,
        email: payload.email,
        role: defaultRole,
        trustMode: 'aws-cognito',
        capabilities: [],
      }
    },
  }
}
