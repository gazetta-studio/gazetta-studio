/**
 * Gazetta tokens (design-agent-access.md Q12, Q15, Q16, Q27): RS256 JWTs
 * that name a person, last 15 minutes, and are renewed from a grant.
 * Verifying one reads no storage.
 */
import { createLocalJWKSet, errors, jwtVerify, SignJWT } from 'jose'
import { publicKeySet, type SigningKeys, TOKEN_ALGORITHM } from './keys.js'

/** How long a token lasts (Q16). */
export const TOKEN_LIFETIME_SECONDS = 15 * 60

/** Accepted clock difference between instances, either way (Q27). */
export const TOKEN_CLOCK_LEEWAY_SECONDS = 60

const ISSUER = 'gazetta'
const AUDIENCE = 'gazetta-admin'

/** Who a token names, as the login layer identified them at approval. */
export interface TokenSubject {
  /** The person's principal id. */
  id: string
  email?: string
  /** The person's role when they approved the login. */
  role: string
  /** The trust mode that identified them. */
  trustMode: string
  /** The grant the token was renewed from. */
  grantId: string
}

export interface VerifiedToken extends TokenSubject {
  /** This token's own id (`jti`). */
  tokenId: string
  /** Expiry, in seconds since the epoch. */
  expiresAt: number
}

export interface IssuedToken {
  token: string
  tokenId: string
  expiresAt: number
}

/** Why a token was refused; the message is safe to show the caller. */
export class TokenRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TokenRejectedError'
  }
}

export async function issueToken(keys: SigningKeys, subject: TokenSubject, now = Date.now()): Promise<IssuedToken> {
  const issuedAt = Math.floor(now / 1000)
  const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS
  const tokenId = crypto.randomUUID()
  const token = await new SignJWT({
    role: subject.role,
    trust: subject.trustMode,
    grant: subject.grantId,
    ...(subject.email ? { email: subject.email } : {}),
  })
    .setProtectedHeader({ alg: TOKEN_ALGORITHM, kid: keys.current.kid, typ: 'JWT' })
    .setSubject(subject.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(tokenId)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(keys.current.privateKey)
  return { token, tokenId, expiresAt }
}

/**
 * Verifies a token's signature (by its `kid`, current or previous key),
 * issuer, audience and times, allowing 60 seconds of clock difference.
 * Throws `TokenRejectedError` otherwise.
 */
export async function verifyToken(keys: SigningKeys, token: string, now = Date.now()): Promise<VerifiedToken> {
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(publicKeySet(keys)), {
      algorithms: [TOKEN_ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: TOKEN_CLOCK_LEEWAY_SECONDS,
      currentDate: new Date(now),
      requiredClaims: ['sub', 'jti', 'exp', 'nbf'],
    })
    const { sub, jti, exp, role, trust, grant, email } = payload
    if (typeof role !== 'string' || typeof trust !== 'string' || typeof grant !== 'string') {
      throw new TokenRejectedError('Token is missing its role, trust mode or grant')
    }
    return {
      id: sub as string,
      role,
      trustMode: trust,
      grantId: grant,
      ...(typeof email === 'string' ? { email } : {}),
      tokenId: jti as string,
      expiresAt: exp as number,
    }
  } catch (err) {
    if (err instanceof TokenRejectedError) throw err
    if (err instanceof errors.JWTExpired) throw new TokenRejectedError('Token has expired', { cause: err })
    if (err instanceof errors.JOSEError) throw new TokenRejectedError('Token is not valid', { cause: err })
    throw err
  }
}
