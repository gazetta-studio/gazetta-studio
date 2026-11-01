/**
 * The CLI sign-in a person approves in the browser (design-agent-access.md
 * Q19, Q21): `gz auth login` shows a code, the person opens
 * `/cli-login/<code>` and approves or denies it. Elevation codes (`gz
 * elevate`, Q12, Q17) use the same page and routes.
 */
import { apiUrl, authHeaders } from './_request.js'
import { apiError, readProblem } from './client.js'

export type ElevationScope = 'non-production' | 'production'

export interface CliLogin {
  /** `login` or `elevation`; older login records leave it out. */
  kind?: 'login' | 'elevation'
  /** For an elevation: the targets it would cover. */
  scope?: ElevationScope
  /** For an approved elevation. */
  elevationId?: string
  endsAt?: string
  code: string
  machine: string
  ip?: string
  startedAt: string
  expiresAt: string
  state: 'pending' | 'approved' | 'denied'
}

export interface CliLoginDecision {
  state: 'approved' | 'denied'
  /** For an approved elevation. */
  elevationId?: string
  endsAt?: string
}

async function send<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
  const res = await fetch(apiUrl(path), { method, headers: authHeaders() })
  if (!res.ok) throw apiError(res, await readProblem(res), 'Request failed')
  return (await res.json()) as T
}

const loginPath = (code: string) => `/auth/logins/${encodeURIComponent(code)}`

export function getCliLogin(code: string): Promise<CliLogin> {
  return send(loginPath(code), 'GET')
}

export function decideCliLogin(code: string, decision: 'approve' | 'deny'): Promise<CliLoginDecision> {
  return send(`${loginPath(code)}/${decision}`, 'POST')
}

/** Ends an elevation now. An elevation already gone (404) counts as ended. */
export async function endElevation(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/auth/elevations/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (res.ok || res.status === 404) return
  throw apiError(res, await readProblem(res), 'Request failed')
}
