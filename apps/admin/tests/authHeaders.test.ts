/**
 * Contract: `authHeaders()` is a pure pass-through.
 *
 * Per `design-auth-rbac.md`, Gazetta consumes upstream identity from
 * configured request headers (forwarded-user, cloudflare-access,
 * azure-easy-auth, etc.). The admin SPA does not implement client-side
 * authentication and must not source auth headers from client-side
 * storage. sessionStorage-backed Bearer tokens are an XSS-exfiltration
 * vector and a security control that would imply an auth model Gazetta
 * does not have.
 *
 * These tests pin the invariant: regardless of what's in sessionStorage
 * / localStorage / cookies, `authHeaders()` returns only the caller-
 * supplied `extra` headers unchanged. If a future contributor wires
 * client-side auth into this helper, these tests fail loud.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { authHeaders } from '../src/client/api/_request.js'

describe('authHeaders', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('returns an empty object when no extra headers are passed', () => {
    expect(authHeaders()).toEqual({})
  })

  it('returns caller-supplied extras unchanged', () => {
    expect(authHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
    })
  })

  it('does NOT inject an Authorization header from sessionStorage', () => {
    // Per design-auth-rbac.md, Gazetta does not implement client-side
    // Bearer auth. If anything in this helper reads a token from
    // sessionStorage and injects an Authorization header, this fails.
    sessionStorage.setItem('gazetta_token', 'attacker-supplied-or-stale-token')
    const headers = authHeaders()
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).toEqual({})
  })

  it('does NOT inject an Authorization header even when extras are passed', () => {
    sessionStorage.setItem('gazetta_token', 'attacker-supplied-or-stale-token')
    const headers = authHeaders({ 'Content-Type': 'application/json' })
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).toEqual({ 'Content-Type': 'application/json' })
  })
})
