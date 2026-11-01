/**
 * The CLI sign-in a person approves in the browser (design-agent-access.md
 * Q19, Q21): `gz auth login` shows a code, the person opens
 * `/cli-login/<code>` and approves or denies it.
 */
import { apiUrl, authHeaders } from './_request.js'
import { apiError, readProblem } from './client.js'

export interface CliLogin {
  code: string
  machine: string
  ip?: string
  startedAt: string
  expiresAt: string
  state: 'pending' | 'approved' | 'denied'
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

export function decideCliLogin(code: string, decision: 'approve' | 'deny'): Promise<{ state: 'approved' | 'denied' }> {
  return send(`${loginPath(code)}/${decision}`, 'POST')
}
