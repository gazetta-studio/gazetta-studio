/**
 * Helpers for routes on `@hono/zod-openapi` that keep the 400s they
 * answered before their input was parsed by schema (#1674).
 *
 * - `jsonBody()` runs before the body validator: it answers a route's own
 *   400 for malformed JSON (the validator would answer "Malformed JSON in
 *   request body"), and lets optional bodies be empty, since the admin
 *   client sends `Content-Type: application/json` on bodyless requests.
 * - `bodyFailure()` is a route hook: a body that fails its schema gets the
 *   route's own code and detail (fixed, or built from the first issue's
 *   message) with the schema's issues; other input gets
 *   the same answer as `apiApp()`'s default hook.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { invalidInput, issueList } from './openapi.js'
import { problem, type ProblemResponse } from './problem.js'
import type { ErrorCode } from './schemas/error.js'

const JSON_TYPE = /^application\/([a-z-.]+\+)?json/i

export interface JsonBodyOptions {
  /** The route's answer to a body that isn't JSON. */
  malformed?: { code: ErrorCode; detail: string }
  /**
   * An empty body, `null`, or (when `malformed` is unset) unparseable JSON
   * reads as `{}`: the route's body is optional.
   */
  optional?: boolean
}

export function jsonBody(opts: JsonBodyOptions): MiddlewareHandler {
  return async (c, next) => {
    const type = c.req.header('content-type')
    if (!type || !JSON_TYPE.test(type)) return next()
    const text = await c.req.text()
    let value: unknown
    let parsed = true
    try {
      value = JSON.parse(text)
    } catch {
      parsed = false
    }
    if (opts.optional && (text.trim() === '' || value === null || (!parsed && !opts.malformed))) {
      // The body validator reads the cached text.
      c.req.bodyCache.text = Promise.resolve('{}') as unknown as string
      return next()
    }
    if (!parsed && opts.malformed) return problem(c, 400, opts.malformed.code, opts.malformed.detail)
    return next()
  }
}

interface ValidationResult {
  success: boolean
  target: string
  error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }
}

export function bodyFailure(code: ErrorCode, detail: string | ((firstIssue: string | undefined) => string)) {
  return (result: ValidationResult, c: Context): ProblemResponse<400> | undefined => {
    if (result.success) return undefined
    const issues = result.error?.issues ?? []
    if (result.target === 'json') {
      const text = typeof detail === 'string' ? detail : detail(issues[0]?.message)
      return problem(c, 400, code, text, { issues: issueList(issues) })
    }
    return invalidInput(c, result.target, issues)
  }
}
