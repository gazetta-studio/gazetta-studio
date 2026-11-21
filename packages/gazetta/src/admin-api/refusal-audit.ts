/**
 * Records write requests refused before a route is matched, and the
 * allowance that bounds how many are written in full (design-audit.md
 * "Recording scope (v1)", #1262).
 *
 * The `GAZETTA_TOKEN` guard and the principal middleware run before the
 * audit middleware, so they can't use `c.var.audit`: this recorder is
 * built once per app with the audit providers and privacy settings and
 * handed to both. The capability middleware asks it whether an anonymous
 * refusal still fits the allowance.
 *
 * Refused write requests from senders without a verified identity share
 * one allowance per instance; users the identity provider verified but
 * who match no role have their own. Each allowance records the first
 * `FULL_ROWS_PER_DAY` (UTC day) in full and counts the rest; when an
 * hour that counted something ends, a timer writes one `sign-in` row
 * with that hour's counts.
 */
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { AuditActor, AuditEvent, AuditProvider } from '../audit/index.js'
import { pseudonymizeActor, type ActorPseudonymMode } from '../audit/pseudonymize.js'
import { recordToAll, type AuditFailureLogger } from '../audit/recorder.js'
import { extractSourceIp, processSourceIp, type SourceIpMode } from '../audit/source-ip.js'
import { processUserAgent, type UserAgentMode } from '../audit/user-agent.js'
import { UNKNOWN_ACTOR_ID, type AuthRefusalCheck } from '../auth/index.js'
import { unmapIPv4 } from '../auth/ip-match.js'

/** Which check refused the request: the provider's, or the `GAZETTA_TOKEN` guard's. */
export type SignInCheck = AuthRefusalCheck | 'token'

/** Full rows per allowance per UTC day; refusals past it are counted. */
export const FULL_ROWS_PER_DAY = 20

/** The longest path stored on a row. */
export const MAX_PATH_LENGTH = 200

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const HOUR_MS = 60 * 60 * 1000

/** The parts of a refused request a row records. */
export interface RefusedRequest {
  method: string
  path: string
  /** Lowercase header names. */
  headers: ReadonlyMap<string, string>
  /** The connection's remote address, when the server exposes it. */
  peerIp?: string
}

export interface RefusalRecorderOptions {
  providers: ReadonlyArray<AuditProvider>
  /** The site's trust mode, recorded on every row. */
  trustMode: string
  actorPseudonym: ActorPseudonymMode
  actorSalt?: string
  recordSourceIp: SourceIpMode
  sourceIpSalt?: string
  trustedProxyCount?: number
  recordUserAgent: UserAgentMode
  logFailure?: AuditFailureLogger
}

export interface RefusalRecorder {
  /**
   * Record a request refused before a route was matched, if it's a write
   * to `/api/*`: a full `sign-in` row while the allowance lasts, else a
   * count. Never throws.
   */
  signIn(req: RefusedRequest, check: SignInCheck, user?: { id: string; email?: string }): Promise<void>
  /**
   * For the capability middleware's 401 to a request with no credential:
   * true while the shared allowance lasts (record the event as usual),
   * false once it's used up (the refusal is counted as `none`).
   */
  admitAnonymous(): boolean
}

type Counted = SignInCheck | 'none'
const COUNTED: ReadonlyArray<Counted> = ['token', 'credentials', 'proxy', 'unverifiable', 'no-role', 'none']

/** The request's method, path, headers and connection address. */
export function refusedRequestFrom(c: Context): RefusedRequest {
  const headers = new Map<string, string>()
  c.req.raw.headers.forEach((value, key) => {
    headers.set(key.toLowerCase(), value)
  })
  let peerIp: string | undefined
  try {
    const address = getConnInfo(c).remote.address
    peerIp = address ? unmapIPv4(address) : undefined
  } catch {
    peerIp = undefined
  }
  return { method: c.req.method, path: c.req.path, headers, ...(peerIp ? { peerIp } : {}) }
}

export function createRefusalRecorder(opts: RefusalRecorderOptions): RefusalRecorder {
  const fullToday = { anonymous: 0, 'no-role': 0 }
  let day = ''
  const hours = new Map<number, Record<Counted, number>>()

  /** True while `allowance` has full rows left today; otherwise counts `check`. */
  function admit(allowance: 'anonymous' | 'no-role', check: Counted): boolean {
    const now = Date.now()
    const today = new Date(now).toISOString().slice(0, 10)
    if (today !== day) {
      day = today
      fullToday.anonymous = 0
      fullToday['no-role'] = 0
    }
    if (fullToday[allowance] < FULL_ROWS_PER_DAY) {
      fullToday[allowance]++
      return true
    }
    const hour = now - (now % HOUR_MS)
    let counts = hours.get(hour)
    if (!counts) {
      counts = Object.fromEntries(COUNTED.map(k => [k, 0])) as Record<Counted, number>
      hours.set(hour, counts)
      const timer = setTimeout(() => void writeCount(hour), hour + HOUR_MS - now)
      ;(timer as { unref?: () => void }).unref?.()
    }
    counts[check]++
    return false
  }

  async function writeCount(hour: number): Promise<void> {
    const counts = hours.get(hour)
    hours.delete(hour)
    if (!counts) return
    await write({
      actor: { id: UNKNOWN_ACTOR_ID, role: 'unknown', trustMode: opts.trustMode },
      metadata: { hour: new Date(hour).toISOString(), ...counts },
    })
  }

  async function write(parts: Pick<AuditEvent, 'actor' | 'metadata' | 'sourceIp' | 'userAgent'>): Promise<void> {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      action: 'sign-in',
      outcome: 'unauthenticated',
      scope: { kind: 'site' },
      ...parts,
    }
    await recordToAll(event, { providers: opts.providers, logFailure: opts.logFailure })
  }

  return {
    async signIn(req, check, user) {
      try {
        await recordSignIn(req, check, user)
      } catch {
        // Never throws: the 401 goes out whatever happens here.
      }
    },
    admitAnonymous() {
      return admit('anonymous', 'none')
    },
  }

  async function recordSignIn(req: RefusedRequest, check: SignInCheck, user?: { id: string; email?: string }) {
    if (!WRITE_METHODS.has(req.method.toUpperCase()) || !/(?:^|\/)api(?:\/|$)/.test(req.path)) return
    if (!admit(check === 'no-role' ? 'no-role' : 'anonymous', check)) return
    const actor: AuditActor =
      check === 'no-role' && user
        ? pseudonymizeActor(
            { id: user.id, ...(user.email ? { email: user.email } : {}), role: 'unknown', trustMode: opts.trustMode },
            opts.actorPseudonym,
            opts.actorSalt,
          )
        : { id: UNKNOWN_ACTOR_ID, role: 'unknown', trustMode: opts.trustMode }
    // Forwarding headers are trusted only when the identity provider
    // verified who sent the request; otherwise the sender wrote them
    // (a connection from outside trustedProxies, say), so the row
    // records the connection's address.
    const rawIp = extractSourceIp({
      trustMode: check === 'no-role' ? opts.trustMode : 'none',
      headers: req.headers,
      peerIp: req.peerIp,
      trustedProxyCount: opts.trustedProxyCount,
    })
    const sourceIp = processSourceIp(rawIp, opts.recordSourceIp, opts.sourceIpSalt) ?? undefined
    const userAgent = processUserAgent(req.headers.get('user-agent'), opts.recordUserAgent) ?? undefined
    await write({
      actor,
      ...(sourceIp !== undefined ? { sourceIp } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
      metadata: { method: req.method, path: req.path.slice(0, MAX_PATH_LENGTH), check },
    })
  }
}
