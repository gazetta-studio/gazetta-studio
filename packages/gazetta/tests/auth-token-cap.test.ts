/**
 * The edit-only cap on Gazetta tokens (design-agent-access.md Q12, Q29).
 */
import { describe, expect, it } from 'vitest'
import { capabilityGrants, expandRole } from '../src/auth/capabilities.js'
import { capTokenCapabilities, deniedOnlyForToken, isWithheldFromTokens } from '../src/auth/token-cap.js'

describe('isWithheldFromTokens', () => {
  it.each([
    ['publish:production', true],
    ['publish:non-production', true],
    ['publish:approve', true],
    ['publish:*', true],
    ['delete:pages', true],
    ['delete:*', true],
    ['restore:history', true],
    ['publish:request', false],
    ['edit:pages', false],
    ['read:audit-log', false],
    ['review:approve', false],
  ])('%s → %s', (cap, withheld) => expect(isWithheldFromTokens(cap)).toBe(withheld))
})

describe('capTokenCapabilities', () => {
  it('expands an admin’s `*` and keeps only what tokens may do', () => {
    const caps = capTokenCapabilities(expandRole('admin')!)
    for (const cap of [
      'publish:production',
      'publish:non-production',
      'publish:approve',
      'delete:pages',
      'restore:history',
    ]) {
      expect(capabilityGrants(caps, cap)).toBe(false)
    }
    for (const cap of ['edit:pages', 'edit:assets', 'read:pages', 'publish:request', 'read:audit-log']) {
      expect(capabilityGrants(caps, cap)).toBe(true)
    }
    expect(caps.some(c => c.endsWith('*'))).toBe(false)
  })

  it('never grants more than the person has', () => {
    const caps = capTokenCapabilities(expandRole('viewer')!)
    expect(capabilityGrants(caps, 'edit:pages')).toBe(false)
  })
})

describe('deniedOnlyForToken', () => {
  const admin = { channel: 'token', browserCapabilities: expandRole('admin')! }
  it('is true for a withheld capability the person has', () => {
    expect(deniedOnlyForToken(admin, 'publish:approve')).toBe(true)
    expect(deniedOnlyForToken(admin, 'delete:*')).toBe(true)
  })
  it('is false in the browser, for a capability the person lacks, and for edits', () => {
    expect(deniedOnlyForToken({ ...admin, channel: 'browser' }, 'publish:approve')).toBe(false)
    expect(
      deniedOnlyForToken({ channel: 'token', browserCapabilities: expandRole('viewer')! }, 'publish:production'),
    ).toBe(false)
    expect(deniedOnlyForToken(admin, 'edit:pages')).toBe(false)
  })
})
