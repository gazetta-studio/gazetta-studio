/**
 * The admin API's OpenAPI contract (design-agent-access.md Q5, Q44).
 *
 * Route modules build their apps with `apiApp()` and register each route
 * with `app.openapi(createRoute(...), handler)`, so a route's schemas and
 * its handler sit together and the document at `/api/openapi.json` can't
 * drift from the routes. Input that fails its schema is answered here, as a
 * problem+json 400, before the handler runs.
 */
import { OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context, Env } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { PROBLEM_CONTENT_TYPE, problem } from './problem.js'
import { type ErrorCode, ErrorResponseSchema } from './schemas/error.js'

/** Marks a route that isn't part of the versioned API (Q5). */
export const UNVERSIONED = { 'x-gazetta-unversioned': true } as const

type Issue = { readonly path: ReadonlyArray<PropertyKey>; readonly message: string }

/** The issues as `{ path, message }`, path dot-joined. */
export function issueList(issues: ReadonlyArray<Issue>) {
  return issues.map(i => ({ path: i.path.map(String).join('.'), message: i.message }))
}

/** The problem+json 400 for input that failed its schema. */
export function invalidInput(c: Context, target: string, issues: ReadonlyArray<Issue>) {
  const list = issueList(issues)
  const where = list[0]?.path ? ` (${list[0].path})` : ''
  return problem(c, 400, 'BAD_REQUEST', `Invalid ${target}${where}: ${list[0]?.message ?? 'invalid'}`, { issues: list })
}

/** A route module's app; failed input answers a problem+json 400. */
export function apiApp<E extends Env = Env>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => (result.success ? undefined : invalidInput(c, result.target, result.error.issues)),
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

/**
 * A Hono route path as an OpenAPI path: `:name` and `:name{.+}` become
 * `{name}`. Routes keep Hono's syntax so patterns such as `{.+}` (page names
 * with slashes) still route; only the document is rewritten.
 */
export function openApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\{[^}]*\})?/g, '{$1}')
}

/** The document with every path in OpenAPI syntax. */
export function withOpenApiPaths<D extends { paths?: Record<string, unknown> }>(doc: D): D {
  if (!doc.paths) return doc
  const paths: Record<string, unknown> = {}
  for (const [path, item] of Object.entries(doc.paths)) paths[openApiPath(path)] = item
  return { ...doc, paths }
}

/**
 * The dev server's own routes, outside the admin app (Q5: unversioned).
 * `gazetta dev` serves them at the site root, so each carries its own
 * server URL.
 */
export function registerDevRoutes(app: OpenAPIHono<any>): void {
  const stream = { description: 'Server-Sent Events', content: { 'text/event-stream': { schema: z.string() } } }
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/__reload',
    summary: 'Reload events for the preview (gazetta dev only)',
    servers: [{ url: '/' }],
    responses: { 200: stream, 204: { description: 'Not the dev server: no reload events' } },
    ...UNVERSIONED,
  })
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/__validation',
    summary: 'Validation scanner events (gazetta dev only)',
    servers: [{ url: '/' }],
    responses: { 200: stream, ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }) },
    ...UNVERSIONED,
  })
}
