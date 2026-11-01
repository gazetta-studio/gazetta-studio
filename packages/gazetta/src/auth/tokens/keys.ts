/**
 * The keys Gazetta signs its tokens with (design-agent-access.md Q25).
 *
 * `GAZETTA_SIGNING_KEY` holds the RS256 private key (PKCS#8 PEM) every
 * admin instance shares; `GAZETTA_SIGNING_KEY_PREVIOUS` optionally holds
 * the key it replaced, accepted for verifying only, so tokens issued just
 * before a rotation keep working until they expire. Each key's id is its
 * RFC 7638 thumbprint, carried in the token header. `gazetta dev` runs as
 * one instance, so it generates a key in memory instead.
 */
import { calculateJwkThumbprint, type CryptoKey, exportJWK, generateKeyPair, importPKCS8, type JWK } from 'jose'

export const TOKEN_ALGORITHM = 'RS256'

export interface SigningKey {
  /** The key id: the public key's RFC 7638 thumbprint. */
  kid: string
  privateKey: CryptoKey
  /** The public key as a JWK, with `kid`, `alg` and `use` set. */
  publicJwk: JWK
}

export interface SigningKeys {
  /** Signs new tokens. */
  current: SigningKey
  /** Verify only: the key `current` replaced. */
  previous?: SigningKey
}

async function fromPrivateKey(privateKey: CryptoKey): Promise<SigningKey> {
  const { kty, n, e } = await exportJWK(privateKey)
  const publicJwk: JWK = { kty, n, e }
  const kid = await calculateJwkThumbprint(publicJwk)
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: TOKEN_ALGORITHM, use: 'sig' } }
}

async function fromPem(pem: string, name: string): Promise<SigningKey> {
  try {
    return await fromPrivateKey(await importPKCS8(pem.replace(/\\n/g, '\n'), TOKEN_ALGORITHM, { extractable: true }))
  } catch (err) {
    throw new Error(`${name} is not an RS256 private key in PKCS#8 PEM form: ${(err as Error).message}`)
  }
}

/**
 * The signing keys from the environment, or null when
 * `GAZETTA_SIGNING_KEY` isn't set (CLI login is then off, Q25).
 * `\n` escapes in the PEM are accepted, for hosts that store
 * environment variables on one line.
 */
export async function signingKeysFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<SigningKeys | null> {
  const current = env.GAZETTA_SIGNING_KEY
  if (!current) return null
  const previous = env.GAZETTA_SIGNING_KEY_PREVIOUS
  return {
    current: await fromPem(current, 'GAZETTA_SIGNING_KEY'),
    ...(previous ? { previous: await fromPem(previous, 'GAZETTA_SIGNING_KEY_PREVIOUS') } : {}),
  }
}

/** A key generated in memory, for a single-instance `gazetta dev`. */
export async function generateSigningKeys(): Promise<SigningKeys> {
  const { privateKey } = await generateKeyPair(TOKEN_ALGORITHM, { extractable: true, modulusLength: 2048 })
  return { current: await fromPrivateKey(privateKey) }
}

/** The public keys, as a JWK set: what verification accepts (and cut 9 publishes). */
export function publicKeySet(keys: SigningKeys): { keys: JWK[] } {
  return { keys: [keys.current.publicJwk, ...(keys.previous ? [keys.previous.publicJwk] : [])] }
}

/**
 * The keys CLI login runs with (design-agent-access.md Q25): the
 * environment's when `GAZETTA_SIGNING_KEY` is set; a generated key under
 * trust `none` (`gazetta dev`, one instance); otherwise null, and CLI
 * login is off: its routes answer 503 and the admin still starts.
 */
export async function resolveCliLoginKeys(
  trustMode: string,
  env: Record<string, string | undefined> = process.env,
): Promise<SigningKeys | null> {
  const fromEnv = await signingKeysFromEnv(env)
  if (fromEnv) return fromEnv
  return trustMode === 'none' ? generateSigningKeys() : null
}
