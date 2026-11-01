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
      'ARCHIVED_NAME_CONFLICT',
      'ASSET_IN_USE',
      'BAD_REQUEST',
      'CONFLICT',
      'EDIT_LOCKED',
      'FORBIDDEN',
      'INTERNAL',
      'NOT_FOUND',
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

const problem = (extra: Record<string, unknown>) => ({
  type: 'about:blank',
  title: 'Bad Request',
  status: 400,
  ...extra,
})

describe('ErrorResponseSchema — RFC 9457 problem bodies', () => {
  it('accepts a problem with code and detail', () => {
    const body = ErrorResponseSchema.parse(
      problem({ code: 'BAD_REQUEST', detail: 'Invalid locale code: NOT_A_LOCALE' }),
    )
    expect(body.code).toBe('BAD_REQUEST')
    expect(body.detail).toBe('Invalid locale code: NOT_A_LOCALE')
  })

  it('accepts FORBIDDEN with a missing-capabilities list', () => {
    // Per design-auth-rbac.md Q3 lock: FORBIDDEN responses carry the
    // missing capability list.
    const body = ErrorResponseSchema.parse(
      problem({ title: 'Forbidden', status: 403, code: 'FORBIDDEN', missing: ['edit:pages'] }),
    )
    expect(body.missing).toEqual(['edit:pages'])
  })

  it('keeps typed extension members (loose object)', () => {
    const body = ErrorResponseSchema.parse(problem({ status: 409, code: 'STALE', currentEtag: 'abc' }))
    expect(body.currentEtag).toBe('abc')
  })

  it('accepts a problem without detail', () => {
    const body = ErrorResponseSchema.parse(problem({ code: 'NOT_FOUND' }))
    expect(body.detail).toBeUndefined()
  })

  it.each([
    ['the old { code, message } shape', { code: 'BAD_REQUEST', message: 'oops' }],
    ['the old { error } shape', { error: 'oops' }],
    ['a missing code', problem({ detail: 'oops' })],
    ['an unknown code', problem({ code: 'WHO_KNOWS' })],
    ['an empty-string code (the cycle 1 mutation)', problem({ code: '' })],
    ['a numeric code', problem({ code: 400 })],
    ['a type other than about:blank', problem({ code: 'BAD_REQUEST', type: 'https://example.com/x' })],
    ['a status below 400', problem({ code: 'BAD_REQUEST', status: 200 })],
    ['missing as non-array', problem({ code: 'FORBIDDEN', missing: 'edit:pages' })],
    ['an empty body', {}],
  ])('rejects %s', (_label, body) => {
    expect(() => ErrorResponseSchema.parse(body)).toThrow()
  })
})
