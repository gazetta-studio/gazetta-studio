/**
 * The admin API's OpenAPI contract (design-agent-access.md Q5, Q44).
 *
 * Route modules build their apps with `apiApp()` and register each route
 * with `app.openapi(createRoute(...), handler)`, so a route's schemas and
 * its handler sit together and the document at `/api/v1/openapi.json`
 * can't drift from the routes. Route modules write paths without the
 * version prefix; the admin app mounts them once under `API_PREFIX`. Input that fails its schema is answered here, as a
 * problem+json 400, before the handler runs.
 */
import { OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi'
import type { Context, Env, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { PROBLEM_CONTENT_TYPE, problem } from './problem.js'
import { type ErrorCode, ErrorResponseSchema } from './schemas/error.js'

/** Where the versioned API is mounted (design-agent-access.md Q42). */
export const API_PREFIX = '/api/v1'

/** The majors this admin serves, newest last (Q43). */
export const API_MAJORS = ['v1'] as const

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

/** Where the document is served, under the versioned prefix. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`

/**
 * The document's header. `docPath` is where the document was requested
 * (`/admin/api/v1/openapi.json` when the CLI mounts the admin at `/admin`),
 * so the server URL makes every documented path resolve.
 */
export function openApiDocument(docPath: string) {
  const base = docPath.slice(0, -OPENAPI_PATH.length)
  return {
    openapi: '3.1.0',
    info: {
      title: 'Gazetta admin API',
      version: 'v1 (preview)',
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

/**
 * The `Gazetta-Run` header (design-agent-access.md Q22, Q47), declared
 * once and referenced from every versioned operation: OpenAPI has no
 * global headers.
 */
export function withRunHeader<D extends { paths?: Record<string, unknown>; components?: object }>(doc: D): D {
  const ref = { $ref: '#/components/parameters/GazettaRun' }
  const methods = ['get', 'put', 'post', 'patch', 'delete']
  const paths: Record<string, unknown> = {}
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!path.startsWith(API_PREFIX)) {
      paths[path] = item
      continue
    }
    const ops = { ...(item as Record<string, { parameters?: unknown[] }>) }
    for (const m of methods) {
      if (ops[m]) ops[m] = { ...ops[m], parameters: [...(ops[m].parameters ?? []), ref] }
    }
    paths[path] = ops
  }
  const components = (doc.components ?? {}) as { parameters?: Record<string, unknown> }
  return {
    ...doc,
    paths,
    components: {
      ...components,
      parameters: {
        ...components.parameters,
        GazettaRun: {
          name: 'Gazetta-Run',
          in: 'header',
          required: false,
          description:
            'The agent run this request belongs to: 1 to 64 letters, digits, ".", "_" or "-". Recorded on the revision and audit event it writes; anything else answers 400.',
          schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
        },
      },
    },
  }
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

/** When a route was deprecated and when it goes away. */
export interface DeprecationDates {
  /** When the route was deprecated. */
  since: Date
  /** When it's removed: at least 6 months after `since`. */
  sunset: Date
}

const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000

/**
 * The route, deprecated: it answers with `Deprecation` (RFC 9745) and
 * `Sunset` (RFC 8594) headers and the document marks it deprecated. The
 * handler doesn't change.
 *
 * A deprecated route keeps working for at least two minor releases or six
 * months, whichever is longer (design-agent-access.md Q43). Only the six
 * months can be checked here: a shorter window throws. The two minor
 * releases are the release's job.
 */
export function deprecate<R extends RouteConfig>(route: R, dates: DeprecationDates): R & { deprecated: true } {
  if (dates.sunset.getTime() - dates.since.getTime() < SIX_MONTHS_MS) {
    throw new Error(
      `${route.method.toUpperCase()} ${route.path}: the sunset must be at least six months after deprecation`,
    )
  }
  const headers: MiddlewareHandler = async (c, next) => {
    await next()
    c.header('Deprecation', `@${Math.floor(dates.since.getTime() / 1000)}`)
    c.header('Sunset', dates.sunset.toUTCString())
  }
  const middleware = route.middleware === undefined ? [] : [route.middleware].flat()
  return { ...route, deprecated: true, middleware: [headers, ...middleware] }
}
