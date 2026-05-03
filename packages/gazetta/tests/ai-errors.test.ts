/**
 * Unit tests for `ai/errors.ts` — verifies the error-class shape every
 * route handler relies on: code, httpStatus, toResponseBody().
 *
 * The pattern mirrors `assets/errors.ts` (route handlers pattern-match
 * on error class to map to HTTP status). These tests guard against a
 * future error subclass forgetting to declare its `httpStatus`.
 */
import { describe, expect, it } from 'vitest'
import { AIAdapterFailedError, AIAdapterUnavailableError, AIError, AIInvalidResponseError } from '../src/ai/errors.js'

describe('AIAdapterUnavailableError', () => {
  it('has code AI_ADAPTER_UNAVAILABLE and 503', () => {
    const err = new AIAdapterUnavailableError('no adapter configured')
    expect(err.code).toBe('AI_ADAPTER_UNAVAILABLE')
    expect(err.httpStatus).toBe(503)
  })

  it('serializes to a response body', () => {
    const err = new AIAdapterUnavailableError('no adapter configured for target staging')
    expect(err.toResponseBody()).toEqual({
      code: 'AI_ADAPTER_UNAVAILABLE',
      message: 'no adapter configured for target staging',
    })
  })

  it('extends AIError and Error', () => {
    const err = new AIAdapterUnavailableError('msg')
    expect(err).toBeInstanceOf(AIError)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('AIAdapterFailedError', () => {
  it('has code AI_ADAPTER_FAILED and 502', () => {
    const err = new AIAdapterFailedError('upstream rejected request')
    expect(err.code).toBe('AI_ADAPTER_FAILED')
    expect(err.httpStatus).toBe(502)
  })

  it('serializes to a response body', () => {
    const err = new AIAdapterFailedError('rate limited')
    expect(err.toResponseBody()).toEqual({
      code: 'AI_ADAPTER_FAILED',
      message: 'rate limited',
    })
  })

  it('preserves cause when constructed with one', () => {
    const cause = new Error('underlying network error')
    const err = new AIAdapterFailedError('upstream rejected request', { cause })
    expect(err.cause).toBe(cause)
  })
})

describe('AIInvalidResponseError', () => {
  it('has code AI_INVALID_RESPONSE and 502', () => {
    const err = new AIInvalidResponseError('missing content field in response')
    expect(err.code).toBe('AI_INVALID_RESPONSE')
    expect(err.httpStatus).toBe(502)
  })

  it('serializes to a response body', () => {
    const err = new AIInvalidResponseError('expected string, got null')
    expect(err.toResponseBody()).toEqual({
      code: 'AI_INVALID_RESPONSE',
      message: 'expected string, got null',
    })
  })
})

describe('discriminated union shape', () => {
  it('every subclass exposes httpStatus typed as 502 | 503', () => {
    // Type-system check: the union of httpStatus values is constrained.
    // If a future error subclass adds 500 or 400, this test won't catch
    // it (compile-time only) — but TypeScript will flag it at the
    // class declaration site against `AIErrorHttpStatus`.
    const errors: AIError[] = [
      new AIAdapterUnavailableError('a'),
      new AIAdapterFailedError('b'),
      new AIInvalidResponseError('c'),
    ]
    for (const err of errors) {
      expect([502, 503]).toContain(err.httpStatus)
    }
  })

  it('every subclass exposes a unique code', () => {
    const codes = new Set([
      new AIAdapterUnavailableError('a').code,
      new AIAdapterFailedError('b').code,
      new AIInvalidResponseError('c').code,
    ])
    expect(codes.size).toBe(3)
  })
})
