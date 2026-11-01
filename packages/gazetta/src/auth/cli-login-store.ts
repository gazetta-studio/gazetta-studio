/**
 * Pending CLI logins and the grants they create (design-agent-access.md
 * Q12, Q16, Q21), kept in the source's private `.gazetta/auth/` folder.
 *
 * - `logins/<code>.json`: a login a client started; the person approves
 *   or denies it in the browser. Expires 10 minutes after it starts.
 * - `logins/<code>.redeemed`: written once, with create-if-absent, when a
 *   client collects an approved login, so a code works once even across
 *   admin instances sharing storage.
 * - `logins/<code>.decided`: written once, with create-if-absent, when the
 *   person approves or denies, so a code is decided once across instances.
 * - Elevation codes (Q12, Q17) share this space: a pending record with
 *   `kind: 'elevation'`, approved and denied on the same page.
 * - `grants/<grantId>.json`: one per approved login. Holds a hash of the
 *   grant secret, never the secret; tokens are renewed from it.
 *
 * Secrets are compared by SHA-256 hash in constant time.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { stateFolderPath } from '../state-folders.js'
import { StorageConditionalFailedError } from '../storage-errors.js'
import type { StorageProvider } from '../types.js'
import type { ElevationScope } from './elevation-store.js'

/** How long a login code works (Q21). */
export const LOGIN_TTL_MS = 10 * 60 * 1000

/** How long a grant renews tokens, from its login's approval (Q16, #1693). */
export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** When a grant stops renewing tokens. */
export function grantExpiresAt(grant: Pick<Grant, 'createdAt'>): number {
  return Date.parse(grant.createdAt) + GRANT_TTL_MS
}

/** The person who approved a login, as the login layer identified them. */
export interface LoginPerson {
  id: string
  email?: string
  role: string
  trustMode: string
}

export interface PendingLogin {
  code: string
  /** The machine name the client reported. */
  machine: string
  /** The address the login was started from, as the request reported it. */
  ip?: string
  startedAt: string
  expiresAt: string
  pollSecretHash: string
  state: 'pending' | 'approved' | 'denied'
  decidedAt?: string
  approvedBy?: LoginPerson
  /** Absent for a login. */
  kind?: 'login' | 'elevation'
  /** For an elevation: the grant it elevates and the scope asked for. */
  grantId?: string
  scope?: ElevationScope
  /** For an approved elevation. */
  elevationId?: string
  endsAt?: string
}

export interface Grant {
  grantId: string
  person: LoginPerson
  machine: string
  createdAt: string
  secretHash: string
}

export type RedeemResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'redeemed' }
  | { status: 'not-found' }
  | { status: 'approved'; grant: Grant; grantSecret: string }
  | { status: 'elevated'; elevationId: string; endsAt: string }

export interface ApprovedElevation {
  elevationId: string
  endsAt: string
}

export type DecideResult =
  | { status: 'ok'; login: PendingLogin }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'decided' }

/** Unambiguous upper-case letters and digits (no I, L, O, U, 0, 1). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

function newCode(): string {
  // randomInt draws uniformly; `byte % 30` would favour the first letters.
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

const newSecret = () => randomBytes(32).toString('base64url')
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')

function sameHash(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hash(secret), 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A code as people type it: upper case, the dash optional. */
export function normalizeLoginCode(code: string): string | null {
  const plain = code.toUpperCase().replace(/[\s-]/g, '')
  if (plain.length !== 8 || [...plain].some(ch => !CODE_ALPHABET.includes(ch))) return null
  return `${plain.slice(0, 4)}-${plain.slice(4)}`
}

/** A grant secret names its grant: `<grantId>.<secret>`. */
function splitGrantSecret(grantSecret: string): { grantId: string; secret: string } | null {
  const dot = grantSecret.indexOf('.')
  if (dot <= 0) return null
  const grantId = grantSecret.slice(0, dot)
  if (!/^[\w-]+$/.test(grantId)) return null
  return { grantId, secret: grantSecret.slice(dot + 1) }
}

export interface StartedCode {
  code: string
  pollSecret: string
  expiresAt: string
}

export interface CliLoginStore {
  start(input: { machine: string; ip?: string }): Promise<StartedCode>
  startElevation(input: { grantId: string; machine: string; ip?: string; scope: ElevationScope }): Promise<StartedCode>
  get(code: string): Promise<PendingLogin | null>
  /**
   * `elevate`: for an elevation code, creates the elevation. Called only
   * once this approval has claimed the code, so a lost race creates none.
   */
  approve(code: string, person: LoginPerson, elevate?: () => Promise<ApprovedElevation>): Promise<DecideResult>
  deny(code: string): Promise<DecideResult>
  redeem(code: string, pollSecret: string): Promise<RedeemResult>
  /**
   * The grant a secret belongs to: `expired` 30 days after approval (the
   * grant is then removed), `invalid` when unknown or revoked.
   */
  grantFor(grantSecret: string): Promise<{ status: 'ok'; grant: Grant } | { status: 'expired' } | { status: 'invalid' }>
  grantById(grantId: string): Promise<Grant | null>
  revoke(grantId: string, personId: string): Promise<'revoked' | 'not-found'>
}

export function createCliLoginStore(storage: StorageProvider, now: () => number = () => Date.now()): CliLoginStore {
  const loginPath = (code: string) => stateFolderPath('auth', 'logins', `${code}.json`)
  const redeemedPath = (code: string) => stateFolderPath('auth', 'logins', `${code}.redeemed`)
  const decidedPath = (code: string) => stateFolderPath('auth', 'logins', `${code}.decided`)
  const grantPath = (grantId: string) => stateFolderPath('auth', 'grants', `${grantId}.json`)

  async function readJson<T>(path: string): Promise<T | null> {
    if (!(await storage.exists(path))) return null
    return JSON.parse(await storage.readFile(path)) as T
  }

  const expired = (login: PendingLogin) => Date.parse(login.expiresAt) <= now()

  async function decide(
    code: string,
    state: 'approved' | 'denied',
    person?: LoginPerson,
    elevate?: () => Promise<ApprovedElevation>,
  ): Promise<DecideResult> {
    const login = await readJson<PendingLogin>(loginPath(code))
    if (!login) return { status: 'not-found' }
    if (expired(login)) return { status: 'expired' }
    if (login.state !== 'pending') return { status: 'decided' }
    try {
      await storage.writeFile(decidedPath(code), state, { ifNoneMatch: '*' })
    } catch (err) {
      if (err instanceof StorageConditionalFailedError) return { status: 'decided' }
      throw err
    }
    const elevation = elevate ? await elevate() : undefined
    const decided: PendingLogin = {
      ...login,
      state,
      decidedAt: new Date(now()).toISOString(),
      ...(person ? { approvedBy: person } : {}),
      ...(elevation ?? {}),
    }
    await storage.writeFile(loginPath(code), JSON.stringify(decided, null, 2))
    return { status: 'ok', login: decided }
  }

  async function startCode(
    fields: Pick<PendingLogin, 'machine' | 'ip' | 'kind' | 'grantId' | 'scope'>,
  ): Promise<StartedCode> {
    const { ip, ...rest } = fields
    const pollSecret = newSecret()
    const startedAt = new Date(now())
    const expiresAt = new Date(startedAt.getTime() + LOGIN_TTL_MS).toISOString()
    // A fresh code collides rarely; create-if-absent makes a collision a retry.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode()
      const login: PendingLogin = {
        ...rest,
        code,
        ...(ip ? { ip } : {}),
        startedAt: startedAt.toISOString(),
        expiresAt,
        pollSecretHash: hash(pollSecret),
        state: 'pending',
      }
      try {
        await storage.writeFile(loginPath(code), JSON.stringify(login, null, 2), { ifNoneMatch: '*' })
        return { code, pollSecret, expiresAt }
      } catch (err) {
        if (!(err instanceof StorageConditionalFailedError)) throw err
      }
    }
    throw new Error('Could not pick a free login code')
  }

  return {
    start: ({ machine, ip }) => startCode({ machine, ip }),
    startElevation: ({ grantId, machine, ip, scope }) => startCode({ kind: 'elevation', grantId, machine, ip, scope }),

    get: code => readJson<PendingLogin>(loginPath(code)),

    approve: (code, person, elevate) => decide(code, 'approved', person, elevate),
    deny: code => decide(code, 'denied'),

    async redeem(code, pollSecret) {
      const login = await readJson<PendingLogin>(loginPath(code))
      // A wrong poll secret looks like an unknown code.
      if (!login || !sameHash(pollSecret, login.pollSecretHash)) return { status: 'not-found' }
      if (login.state === 'denied') return { status: 'denied' }
      if (expired(login)) return { status: 'expired' }
      if (login.state === 'pending' || !login.approvedBy) return { status: 'pending' }
      // An elevation answers its id and end time; polling again is harmless.
      if (login.kind === 'elevation') {
        return login.elevationId && login.endsAt
          ? { status: 'elevated', elevationId: login.elevationId, endsAt: login.endsAt }
          : { status: 'pending' }
      }
      try {
        await storage.writeFile(redeemedPath(code), new Date(now()).toISOString(), { ifNoneMatch: '*' })
      } catch (err) {
        if (err instanceof StorageConditionalFailedError) return { status: 'redeemed' }
        throw err
      }
      const grantId = crypto.randomUUID()
      const secret = newSecret()
      const grant: Grant = {
        grantId,
        person: login.approvedBy,
        machine: login.machine,
        createdAt: new Date(now()).toISOString(),
        secretHash: hash(secret),
      }
      await storage.writeFile(grantPath(grantId), JSON.stringify(grant, null, 2), { ifNoneMatch: '*' })
      return { status: 'approved', grant, grantSecret: `${grantId}.${secret}` }
    },

    async grantFor(grantSecret) {
      const parts = splitGrantSecret(grantSecret)
      if (!parts) return { status: 'invalid' }
      const grant = await readJson<Grant>(grantPath(parts.grantId))
      if (!grant || !sameHash(parts.secret, grant.secretHash)) return { status: 'invalid' }
      if (grantExpiresAt(grant) <= now()) {
        await storage.rm(grantPath(grant.grantId))
        return { status: 'expired' }
      }
      return { status: 'ok', grant }
    },

    async grantById(grantId) {
      return /^[\w-]+$/.test(grantId) ? readJson<Grant>(grantPath(grantId)) : null
    },

    async revoke(grantId, personId) {
      if (!/^[\w-]+$/.test(grantId)) return 'not-found'
      const grant = await readJson<Grant>(grantPath(grantId))
      // Someone else's grant answers as if it didn't exist.
      if (!grant || grant.person.id !== personId) return 'not-found'
      await storage.rm(grantPath(grantId))
      return 'revoked'
    },
  }
}
