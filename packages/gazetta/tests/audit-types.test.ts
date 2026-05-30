/**
 * Cut 1 tests: audit type vocabulary + schema parse + error
 * taxonomy. Pure-data layer; no providers yet.
 *
 * Pin the wire shape so v2 sinks can't drift the contract.
 */
import { describe, expect, it } from 'vitest'
import {
  AuditConfigSchema,
  AuditConfigurationError,
  AuditError,
  AuditTransportError,
  DEFAULT_AUDIT_CONFIG,
  type AuditAction,
  type AuditConfig,
  type AuditEvent,
  type AuditQuery,
} from '../src/audit/index.js'
import { AuditActionSchema, AuditEventSchema } from '../src/admin-api/schemas/audit.js'

describe('AuditConfigSchema (Cut 1)', () => {
  it('accepts the minimal history-provider config', () => {
    const r = AuditConfigSchema.safeParse({ provider: 'history' })
    expect(r.success).toBe(true)
  })

  it('accepts retention.events + maxAgeMonths', () => {
    const r = AuditConfigSchema.safeParse({
      provider: 'history',
      retention: { events: 10000, maxAgeMonths: 72 },
    })
    expect(r.success).toBe(true)
  })

  it('accepts retention.maxAgeMonths: null (no time limit)', () => {
    const r = AuditConfigSchema.safeParse({
      provider: 'history',
      retention: { maxAgeMonths: null },
    })
    expect(r.success).toBe(true)
  })

  it('accepts strict mode', () => {
    expect(AuditConfigSchema.safeParse({ provider: 'history', strict: true }).success).toBe(true)
  })

  it('accepts pseudonymization modes', () => {
    expect(AuditConfigSchema.safeParse({ provider: 'history', actorPseudonym: 'none' }).success).toBe(true)
    expect(AuditConfigSchema.safeParse({ provider: 'history', actorPseudonym: 'sha256' }).success).toBe(true)
    expect(AuditConfigSchema.safeParse({ provider: 'history', actorPseudonym: 'invalid' }).success).toBe(false)
  })

  it('accepts sourceIp recording modes', () => {
    for (const mode of ['none', 'raw', 'hashed', 'truncated']) {
      expect(AuditConfigSchema.safeParse({ provider: 'history', recordSourceIp: mode }).success).toBe(true)
    }
    expect(AuditConfigSchema.safeParse({ provider: 'history', recordSourceIp: 'unknown' }).success).toBe(false)
  })

  it('accepts userAgent recording modes', () => {
    for (const mode of ['none', 'raw', 'truncated']) {
      expect(AuditConfigSchema.safeParse({ provider: 'history', recordUserAgent: mode }).success).toBe(true)
    }
    // 'hashed' is intentionally NOT a userAgent mode (low entropy);
    // schema rejects it.
    expect(AuditConfigSchema.safeParse({ provider: 'history', recordUserAgent: 'hashed' }).success).toBe(false)
  })

  it('rejects unknown provider name', () => {
    const r = AuditConfigSchema.safeParse({ provider: 'cloudwatch' })
    expect(r.success).toBe(false)
  })

  it('rejects extra unknown fields (strict mode)', () => {
    const r = AuditConfigSchema.safeParse({ provider: 'history', extra: 'nope' })
    expect(r.success).toBe(false)
  })

  it('rejects retention with negative or zero counts', () => {
    expect(AuditConfigSchema.safeParse({ provider: 'history', retention: { events: 0 } }).success).toBe(false)
    expect(AuditConfigSchema.safeParse({ provider: 'history', retention: { events: -1 } }).success).toBe(false)
  })

  it('DEFAULT_AUDIT_CONFIG parses cleanly through the schema', () => {
    expect(AuditConfigSchema.safeParse(DEFAULT_AUDIT_CONFIG).success).toBe(true)
  })
})

describe('Error taxonomy (Cut 1)', () => {
  it('AuditConfigurationError extends AuditError + httpStatus 500', () => {
    const err = new AuditConfigurationError('bad config')
    expect(err).toBeInstanceOf(AuditError)
    expect(err.httpStatus).toBe(500)
    expect(err.name).toBe('AuditConfigurationError')
  })

  it('AuditTransportError extends AuditError + carries category', () => {
    const err = new AuditTransportError('connection refused', 'transport')
    expect(err).toBeInstanceOf(AuditError)
    expect(err.category).toBe('transport')
    expect(err.name).toBe('AuditTransportError')
  })

  it('AuditTransportError category is closed enum', () => {
    // Type-level check: TS rejects 'unknown' at compile time.
    // Runtime: the constructor accepts what callers pass; the
    // closed type guards against typos at the consumer site.
    expect(new AuditTransportError('x', 'serialize').category).toBe('serialize')
    expect(new AuditTransportError('x', 'quota').category).toBe('quota')
  })
})

describe('Type-level shape (Cut 1)', () => {
  it('AuditEvent shape compiles with required + optional fields', () => {
    const minimal: AuditEvent = {
      timestamp: '2026-05-07T15:00:00Z',
      actor: { id: 'alice', role: 'editor', trustMode: 'cloudflare-access' },
      action: 'save',
      outcome: 'success',
      scope: { kind: 'page', name: 'home' },
    }
    expect(minimal.actor.id).toBe('alice')

    const full: AuditEvent = {
      timestamp: '2026-05-07T15:00:00Z',
      actor: { id: 'alice', email: 'alice@example.com', role: 'editor', trustMode: 'cloudflare-access' },
      action: 'publish',
      outcome: 'success',
      scope: { kind: 'page', name: 'home' },
      sourceIp: '203.0.113.1',
      userAgent: 'Chrome/119',
      metadata: { destinationTarget: 'production' },
    }
    expect(full.metadata?.destinationTarget).toBe('production')
  })

  it('AuditQuery accepts every documented filter', () => {
    const q: AuditQuery = {
      actor: 'alice',
      action: 'save',
      outcome: 'success',
      scope: { kind: 'page', name: 'home' },
      since: '2026-01-01T00:00:00Z',
      until: '2026-12-31T00:00:00Z',
      limit: 50,
    }
    expect(q.limit).toBe(50)
  })

  it('AuditConfig is the schema-inferred type', () => {
    // Compile-time check: parsed config matches the AuditConfig type.
    const cfg: AuditConfig = AuditConfigSchema.parse({ provider: 'history' })
    expect(cfg.provider).toBe('history')
  })
})

describe('AuditAction "create-redirect" (Cut 2 of redirect-ui per design-redirect-ui.md Q7)', () => {
  // Per design-redirect-ui.md Q7 lock — closed-enum-additive extension.
  // Manual Redirect creation gets its own action verb (matching the
  // soft-delete pattern of archive/unarchive/purge/rename) rather
  // than a `metadata.manual: true` flag on `archive`. The AuditQuery
  // closed-enum discriminator is what makes "show all manual
  // redirects last week" forensically reliable.

  it('AuditAction type union accepts "create-redirect"', () => {
    const action: AuditAction = 'create-redirect'
    expect(action).toBe('create-redirect')
  })

  it('AuditEvent compiles with action "create-redirect" + metadata.aliasOf', () => {
    const event: AuditEvent = {
      timestamp: '2026-05-14T15:00:00Z',
      actor: { id: 'alice', role: 'editor', trustMode: 'cloudflare-access' },
      action: 'create-redirect',
      outcome: 'success',
      scope: { kind: 'page', name: 'old-products' },
      metadata: { aliasOf: 'products/featured' },
    }
    const round = JSON.parse(JSON.stringify(event))
    expect(round.action).toBe('create-redirect')
    expect(round.metadata.aliasOf).toBe('products/featured')
  })

  it('AuditEvent supports fragment-kind create-redirect with metadata.aliasOf', () => {
    // Per Q6 lock — both pages and fragments in v1.
    const event: AuditEvent = {
      timestamp: '2026-05-14T15:00:00Z',
      actor: { id: 'bob', role: 'editor', trustMode: 'cloudflare-access' },
      action: 'create-redirect',
      outcome: 'success',
      scope: { kind: 'fragment', name: 'old-header' },
      metadata: { aliasOf: 'header' },
    }
    expect(event.scope.kind).toBe('fragment')
  })
})

describe('AuditActionSchema (Cut 2 of redirect-ui)', () => {
  it('parses "create-redirect" successfully', () => {
    const r = AuditActionSchema.safeParse('create-redirect')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe('create-redirect')
  })

  it('AuditEventSchema parses a create-redirect event with metadata.aliasOf', () => {
    const event = {
      timestamp: '2026-05-14T15:00:00Z',
      actor: { id: 'alice', role: 'editor', trustMode: 'cloudflare-access' },
      action: 'create-redirect',
      outcome: 'success',
      scope: { kind: 'page', name: 'old-products' },
      metadata: { aliasOf: 'products/featured' },
    }
    const r = AuditEventSchema.safeParse(event)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.action).toBe('create-redirect')
      expect(r.data.metadata?.aliasOf).toBe('products/featured')
    }
  })

  it('rejects unknown action "create-redirect-typo" (closed-enum preserved)', () => {
    const r = AuditActionSchema.safeParse('create-redirect-typo')
    expect(r.success).toBe(false)
  })

  it('rejects unknown action "create-alias" (closed-enum preserved)', () => {
    const r = AuditActionSchema.safeParse('create-alias')
    expect(r.success).toBe(false)
  })
})
