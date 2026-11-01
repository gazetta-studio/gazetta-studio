/**
 * Shared shape for admin-API error responses.
 *
 * Every error response is an RFC 9457 problem (`type`, `title`,
 * `status`, `detail`) with a `code` from `ErrorCodeSchema`. Error classes
 * that carry typed extras (`STALE` carries `current` + `currentEtag`;
 * `VALIDATION_FAILED` carries `issues`) add them as extension members.
 *
 * # Why this exists
 *
 * Per `docs/audits/test-quality-with-ai.md` cycle 1: error-shape
 * tautology was the highest-leverage finding. Tests asserted on
 * status code only; mutation testing showed `code: 'BAD_REQUEST'`
 * survives mutation to `code: ''` because no test asserts on the
 * body's `code` field. The fix is structural — assert against the
 * schema, not the observed shape.
 *
 * # Usage
 *
 * Tests assert on error responses through `ErrorResponseSchema`:
 *
 *   const body = ErrorResponseSchema.parse(await res.json())
 *   expect(body.code).toBe('BAD_REQUEST')
 *
 * `parse` (not `safeParse`) is intentional — a malformed error body
 * is itself a regression. Failing to round-trip through the schema
 * is the assertion.
 *
 * # Extending
 *
 * Routes that emit a typed error variant declare a discriminated
 * schema in their own module (e.g. `StaleResponseSchema` in
 * `pages.ts`). The base `ErrorCodeSchema` enum lists every code
 * the admin-API may emit; extend it when new error classes ship.
 */
import { z } from 'zod'
import type { AssetErrorCode } from '../../assets/errors.js'
import type { AIErrorCode } from '../../ai/errors.js'

/**
 * Closed enum of every error code the admin-API emits.
 *
 * Adding a new error class = one new entry here + a route-module
 * extension if the error carries typed extras. Keeping the enum
 * closed prevents drift: a route that returns `code: 'NEW_THING'`
 * without updating this enum fails schema validation in tests, which
 * surfaces the missing entry before it ships. The asset and AI error
 * classes' codes are checked against it at compile time below.
 */
export const ErrorCodeSchema = z.enum([
  'AI_ADAPTER_FAILED',
  'AI_ADAPTER_UNAVAILABLE',
  'AI_INVALID_RESPONSE',
  'ALIAS_TARGET_NOT_FOUND',
  'ARCHIVE_HAS_LIVE_REFS',
  'ARCHIVED',
  'ARCHIVED_CONFLICT',
  'ARCHIVED_NAME_CONFLICT',
  'ASSET_IN_USE',
  'ASSET_KIND_MISMATCH',
  'ASSET_MANIFEST_CORRUPT',
  'ASSET_MANIFEST_NOT_FOUND',
  'ASSET_MIME_MISMATCH',
  'ASSET_MIME_UNSUPPORTED',
  'ASSET_NAME_COLLISION',
  'ASSET_NAME_INVALID',
  'ASSET_NAME_RESERVED',
  'ASSET_PATH_TRAVERSAL',
  'ASSET_PREPROCESS_FAILED',
  'ASSET_SIZE_EXCEEDED',
  'ASSET_STORAGE_FAILURE',
  'ASSET_VALIDATION_FAILED',
  'ASSET_VARIANT_GENERATION_FAILED',
  'AUDIT_FAILED',
  'BAD_REQUEST',
  'BROWSER_REQUIRED',
  'CLI_LOGIN_UNAVAILABLE',
  'CONFLICT',
  'DELETE_BLOCKED',
  'EDIT_LOCKED',
  'ELEVATION_REQUIRED',
  'FORBIDDEN',
  'GRANT_EXPIRED',
  'GRANT_INVALID',
  'HOOK_CANCELLED',
  'INTERNAL',
  'INVALID',
  'INVALID_CONFLICT_MODE',
  'LIVE_CONFLICT',
  'LIVE_NAME_CONFLICT',
  'LOGIN_DENIED',
  'LOGIN_EXPIRED',
  'LOGIN_REDEEMED',
  'NAME_COLLISION',
  'NOT_ARCHIVED',
  'NOT_FOUND',
  'PUBLISH_AUDIT_FAILED',
  'REDIRECT_RESTORE',
  'RENAME_PARTIAL',
  'RENDER_FAILED',
  'STALE',
  'STORAGE_WRITE_FAILED',
  'TARGET_NOT_EDITABLE',
  'TEMPLATE_INVALID',
  'TOKEN_EDIT_ONLY',
  'TOKEN_INVALID',
  'TOKEN_REQUIRED',
  'UNAUTHENTICATED',
  'VALIDATION_FAILED',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

// Every code the asset and AI error classes can carry must be in the enum.
type AssertCodes<T extends ErrorCode> = T
export type _AssetCodesInEnum = AssertCodes<AssetErrorCode>
export type _AICodesInEnum = AssertCodes<AIErrorCode>

/**
 * Base error-response shape: RFC 9457 problem details
 * (`application/problem+json`, `design-agent-access.md` Q45), built by
 * `problem()` in `admin-api/problem.ts`. `type` is `about:blank`, so
 * `title` is the HTTP status phrase; `detail` is the human-readable
 * message; `code` is an extension member. Typed extras (`issues` on
 * `VALIDATION_FAILED`, `current` and `currentEtag` on `STALE`, `missing`
 * on `FORBIDDEN`, ...) are further extension members, so the object is
 * loose.
 */
export const ErrorResponseSchema = z.looseObject({
  type: z.literal('about:blank'),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  code: ErrorCodeSchema,
  missing: z.array(z.string()).optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
