/**
 * The admin API's OpenAPI contract (design-agent-access.md Q5, Q44).
 *
 * Route modules build their apps with `apiApp()` and register each route
 * with `app.openapi(createRoute(...), handler)`, so a route's schemas and
 * its handler sit together and the document at `/api/openapi.json` can't
 * drift from the routes. Input that fails its schema is answered here, as a
 * problem+json 400, before the handler runs.
 */
import { OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { PROBLEM_CONTENT_TYPE, problem } from './problem.js'
import { type ErrorCode, ErrorResponseSchema } from './schemas/error.js'

/** Marks a route that isn't part of the versioned API (Q5). */
export const UNVERSIONED = { 'x-gazetta-unversioned': true } as const

/** A route module's app; failed input answers a problem+json 400. */
export function apiApp<E extends Env = Env>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (result.success) return
      const issues = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }))
      const where = issues[0]?.path ? ` (${issues[0].path})` : ''
      return problem(c, 400, 'BAD_REQUEST', `Invalid ${result.target}${where}: ${issues[0]?.message ?? 'invalid'}`, {
        issues,
      })
    },
  })
}

/** A JSON success response. */
export function json<S extends z.ZodType>(schema: S, description: string) {
  return { description, content: { 'application/json': { schema } } }
}

const DESCRIPTIONS: Record<number, string> = {
  400: 'The request is invalid',
  401: 'Not signed in',
  403: 'Missing a capability',
  404: 'Not found',
  409: 'Conflicts with the current state',
  412: 'Precondition failed',
  413: 'Too large',
  415: 'Unsupported media type',
  500: 'Unexpected error',
  502: 'An upstream service failed',
  503: 'A service is unavailable',
}

/**
 * Problem+json responses for the given statuses, each with the codes a
 * route can answer for it (documentation; every body is `ErrorResponseSchema`).
 */
export function problems<S extends ContentfulStatusCode>(spec: Partial<Record<S, readonly ErrorCode[]>>) {
  const out = {} as Record<
    S,
    { description: string; content: { [PROBLEM_CONTENT_TYPE]: { schema: typeof ErrorResponseSchema } } }
  >
  for (const [status, codes] of Object.entries(spec) as [string, readonly ErrorCode[]][]) {
    const s = Number(status) as S
    out[s] = {
      description: `${DESCRIPTIONS[s] ?? 'Error'}${codes.length ? `: ${codes.join(', ')}` : ''}`,
      content: { [PROBLEM_CONTENT_TYPE]: { schema: ErrorResponseSchema } },
    }
  }
  return out
}

/**
 * The document's header. `docPath` is where the document was requested
 * (`/admin/api/openapi.json` when the CLI mounts the admin at `/admin`), so
 * the server URL makes every documented path resolve.
 */
export function openApiDocument(docPath: string) {
  const base = docPath.slice(0, -'/api/openapi.json'.length)
  return {
    openapi: '3.1.0',
    info: {
      title: 'Gazetta admin API',
      version: 'preview',
      description:
        'The admin API every Gazetta client uses (design-agent-access.md Q5). A preview until v1; routes marked `x-gazetta-unversioned` are outside the versioned contract. Errors are RFC 9457 problem+json.',
    },
    servers: [{ url: base || '/' }],
  }
}
