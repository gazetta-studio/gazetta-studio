/**
 * Admin-API error responses as RFC 9457 problem details
 * (`design-agent-access.md` Q45).
 *
 * Every error the admin API answers goes through `problem()` or
 * `problemFrom()`: routes choose only the status, the code and any typed
 * extras. `type` is `about:blank`, so `title` is the status phrase
 * (RFC 9457 §4.2.1); `code` is an extension member from `ErrorCodeSchema`.
 */
import type { Context, TypedResponse } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { JSONParsed } from 'hono/utils/types'
import type { ErrorCode, ErrorResponse } from './schemas/error.js'

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  423: 'Locked',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export interface ProblemBody {
  type: 'about:blank'
  title: string
  status: number
  detail?: string
  code: ErrorCode
  [extension: string]: unknown
}

/** The problem body; extras can't override the standard members or `code`. */
export function problemBody(
  status: number,
  code: ErrorCode,
  detail?: string,
  extras: Record<string, unknown> = {},
): ProblemBody {
  return {
    ...extras,
    type: 'about:blank',
    title: STATUS_TITLES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    code,
  }
}

/**
 * A problem response. Typed as a JSON response too, so `openapi()` handlers
 * that declare `application/problem+json` responses can return it.
 */
export type ProblemResponse<S extends ContentfulStatusCode = ContentfulStatusCode> = Response &
  TypedResponse<JSONParsed<ErrorResponse>, S, 'json'>

/** Answer an error as `application/problem+json`. */
export function problem<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: ErrorCode,
  detail?: string,
  extras?: Record<string, unknown>,
): ProblemResponse<S> {
  return c.body(JSON.stringify(problemBody(status, code, detail, extras)), status, {
    'Content-Type': PROBLEM_CONTENT_TYPE,
  }) as unknown as ProblemResponse<S>
}

/**
 * Answer an error class's `{ code, message, ...extras }` body (the shape
 * `toResponseBody()` returns) as a problem: `message` becomes `detail`.
 */
export function problemFrom<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  body: { readonly code: string; readonly message?: string },
): ProblemResponse<S> {
  const { code, message, ...extras } = body as { code: ErrorCode; message?: string } & Record<string, unknown>
  return problem(c, status, code, message, extras)
}
