/**
 * Schema-level coverage for `ErrorResponseSchema` and `ErrorCodeSchema`.
 *
 * The schema is now the contract every admin-API error test asserts
 * against (per `docs/audits/test-quality-with-ai.md` cycle 1
 * recommendation 1). Validating the schema's own shape protects the
 * downstream tests from silent contract drift.
 *
 * Per rule 26 (test-isolation paranoia): no shared state; every test
 * works against literal payloads.
 */
import { describe, expect, it } from 'vitest'
import { ErrorCodeSchema, ErrorResponseSchema } from '../src/admin-api/schemas/error.js'

describe('ErrorCodeSchema — closed enum of admin-API error codes', () => {
  it('accepts every documented error code', () => {
    const codes = [
      'AI_ADAPTER_FAILED',
      'AI_ADAPTER_UNAVAILABLE',
      'ARCHIVED_NAME_CONFLICT',
      'ASSET_MANIFEST_NOT_FOUND',
      'BAD_REQUEST',
      'FORBIDDEN',
      'HOOK_CANCELLED',
      'NOT_FOUND',
      'PUBLISH_AUDIT_FAILED',
      'STALE',
      'UNAUTHENTICATED',
      'VALIDATION_FAILED',
    ]
    for (const code of codes) {
      expect(() => ErrorCodeSchema.parse(code)).not.toThrow()
    }
  })

  it('rejects unknown codes (closed-enum invariant)', () => {
    // Closed enum prevents drift: a route emitting an undocumented
    // code fails schema validation in tests, surfacing the missing
    // entry before it ships.
    expect(() => ErrorCodeSchema.parse('NEW_CODE')).toThrow()
    expect(() => ErrorCodeSchema.parse('bad_request')).toThrow() // case-sensitive
    expect(() => ErrorCodeSchema.parse('')).toThrow() // empty rejected
  })
})

describe('ErrorResponseSchema — shape of admin-API error responses', () => {
  it('accepts the canonical { code, message } shape', () => {
    const body = ErrorResponseSchema.parse({
      code: 'BAD_REQUEST',
      message: 'Invalid locale code: NOT_A_LOCALE',
    })
    expect(body.code).toBe('BAD_REQUEST')
    expect(body.message).toBe('Invalid locale code: NOT_A_LOCALE')
  })

  it('accepts FORBIDDEN with a missing-capabilities list', () => {
    // Per design-auth-rbac.md Q3 lock: FORBIDDEN responses carry the
    // missing capability list. The base schema reserves this field so
    // tests don't have to discriminate by code first.
    const body = ErrorResponseSchema.parse({
      code: 'FORBIDDEN',
      message: 'Missing capability',
      missing: ['edit:pages'],
    })
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:pages'])
  })

  it('accepts code without message (forward-compat for terse error classes)', () => {
    // `message` is optional — future error classes might omit it if
    // the code alone carries enough information. Schema must allow it.
    const body = ErrorResponseSchema.parse({ code: 'NOT_FOUND' })
    expect(body.code).toBe('NOT_FOUND')
    expect(body.message).toBeUndefined()
  })

  it('rejects responses missing the code field', () => {
    expect(() => ErrorResponseSchema.parse({ message: 'oops' })).toThrow()
  })

  it('rejects responses with an unknown code (closed-enum)', () => {
    expect(() => ErrorResponseSchema.parse({ code: 'WHO_KNOWS', message: 'oops' })).toThrow()
  })

  it('rejects empty body', () => {
    // The textbook tautology survivor from cycle 1: assets.ts:404
    // mutated `c.json({ code: 'BAD_REQUEST', message: '...' }, 400)`
    // to `c.json({}, 400)` and tests stayed green because they only
    // checked status. Schema parse on the body would have caught it.
    expect(() => ErrorResponseSchema.parse({})).toThrow()
  })

  it('rejects responses with empty-string code (the cycle 1 mutation)', () => {
    // assets.ts:61 survived `code: 'BAD_REQUEST'` → `code: ''`. Empty
    // string isn't a valid enum member; schema parse rejects it.
    expect(() => ErrorResponseSchema.parse({ code: '', message: 'oops' })).toThrow()
  })

  it('rejects responses with non-string code', () => {
    expect(() => ErrorResponseSchema.parse({ code: 400, message: 'oops' })).toThrow()
  })

  it('rejects missing as non-array', () => {
    // Forward-compat: if a future error class accidentally emits
    // `missing: 'edit:pages'` instead of `['edit:pages']`, schema
    // parse rejects it before consumers see the malformed shape.
    expect(() =>
      ErrorResponseSchema.parse({
        code: 'FORBIDDEN',
        message: 'oops',
        missing: 'edit:pages',
      }),
    ).toThrow()
  })
})
