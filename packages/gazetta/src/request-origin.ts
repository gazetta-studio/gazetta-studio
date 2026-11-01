/**
 * Where a write came from (design-agent-access.md Q47): the channel (the
 * person's browser, a Gazetta token, later MCP), the agent run it belongs
 * to (Q22), and for token requests which token and whether an elevation
 * covered it. The actor stays the person.
 *
 * One middleware maps each admin request to an origin (`originOf`) and
 * runs the request inside it; `recordWrite` and the audit recorder copy
 * it into revisions and events. Route handlers never set these fields.
 * A request-scoped store keeps the write paths, several outside
 * the routes, from each threading the principal through.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Principal } from './auth/types.js'

export type Channel = 'browser' | 'token' | 'mcp'

export interface RequestOrigin {
  channel: Channel
  /** The agent run, from the `Gazetta-Run` header. */
  runId?: string
  /** For a token request: the token that made it. */
  tokenId?: string
  /** For a token request: whether an elevation covered it (Q17). */
  elevated?: boolean
  /** The person's principal id. */
  author: string
}

/** The fields revisions and audit events carry. */
export type OriginFields = Pick<RequestOrigin, 'channel' | 'runId' | 'tokenId' | 'elevated'>

/** The request header carrying the run id (Q22). */
export const RUN_HEADER = 'Gazetta-Run'

/** A run id: at most 64 characters of letters, digits, `.`, `_` and `-`. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** The origin of a request from its principal and run id. */
export function originOf(principal: Principal, runId?: string): RequestOrigin {
  const token = principal.channel === 'token'
  return {
    channel: token ? 'token' : 'browser',
    ...(runId ? { runId } : {}),
    ...(token && principal.tokenId ? { tokenId: principal.tokenId } : {}),
    ...(token ? { elevated: false } : {}),
    author: principal.id,
  }
}

const store = new AsyncLocalStorage<RequestOrigin>()

/** Runs `fn` with `origin` as the current request's origin. */
export function runWithOrigin<T>(origin: RequestOrigin, fn: () => T): T {
  return store.run(origin, fn)
}

/** The current request's origin, outside a request undefined (CLI, tests). */
export function currentOrigin(): RequestOrigin | undefined {
  return store.getStore()
}

/** Records that an elevation let the current token request through. */
export function markElevated(): void {
  const origin = store.getStore()
  if (origin?.channel === 'token') origin.elevated = true
}

/** The origin's fields for a revision or event; undefined outside a request. */
export function originFields(origin = currentOrigin()): OriginFields | undefined {
  if (!origin) return undefined
  const { author: _author, ...fields } = origin
  return fields
}
