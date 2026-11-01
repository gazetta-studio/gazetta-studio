/**
 * Signing in a command line from the browser (design-agent-access.md Q15,
 * Q23): which setup this admin needs, a shared Cloudflare service token to
 * copy, and, behind ALB, a grant to paste into `gz auth login --paste`.
 */
import { apiUrl, authHeaders } from './_request.js'
import { apiError, readProblem } from './client.js'

export interface CliSetup {
  trustMode: string
  /** Behind ALB: create a grant here and paste it. */
  paste: boolean
  cloudflare?: { clientId: string; clientSecret: string }
}

export interface CreatedGrant {
  grantId: string
  /** Shown once. */
  grantSecret: string
}

export async function getCliSetup(): Promise<CliSetup> {
  const res = await fetch(apiUrl('/auth/cli-setup'), { headers: authHeaders() })
  if (!res.ok) throw apiError(res, await readProblem(res), 'Request failed')
  return (await res.json()) as CliSetup
}

export async function createCliGrant(machine: string): Promise<CreatedGrant> {
  const res = await fetch(apiUrl('/auth/grants'), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine }),
  })
  if (!res.ok) throw apiError(res, await readProblem(res), 'Request failed')
  return (await res.json()) as CreatedGrant
}
