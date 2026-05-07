/**
 * Cut 3 tests: audit-recording dispatcher.
 *
 * Verifies the load-bearing invariants per design-audit.md:
 *   - Parallel fan-out (Promise.allSettled, not sequential)
 *   - Fail-open default — never throws
 *   - Failure logger receives PII-FREE entries (no payload)
 *   - Strict mode shape — caller branches on result.failed
 *   - Empty providers array is a valid state (zero-config; never
 *     throws)
 *   - AuditTransportError category preserved through the failure
 *     log when providers throw it; default 'transport' for unknown
 *     errors
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AuditTransportError,
  recordToAll,
  type AuditEvent,
  type AuditFailureLog,
  type AuditProvider,
} from '../src/audit/index.js'

function event(): AuditEvent {
  return {
    timestamp: '2026-05-07T15:00:00Z',
    actor: { id: 'alice', email: 'alice@example.com', role: 'editor', trustMode: 'cloudflare-access' },
    action: 'save',
    outcome: 'success',
    scope: { kind: 'page', name: 'home' },
  }
}

function provider(
  name: string,
  behavior: 'ok' | 'throw' | 'transport-throw' | 'serialize-throw' = 'ok',
): AuditProvider {
  return {
    name,
    async record(): Promise<void> {
      if (behavior === 'ok') return
      if (behavior === 'throw') throw new Error(`${name}: generic failure`)
      if (behavior === 'transport-throw') throw new AuditTransportError(`${name}: connection refused`, 'transport')
      if (behavior === 'serialize-throw') throw new AuditTransportError(`${name}: bad shape`, 'serialize')
    },
  }
}

describe('recordToAll (Cut 3)', () => {
  it('zero providers → succeeded 0, failed 0, never throws', async () => {
    const result = await recordToAll(event(), { providers: [] })
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.failures).toEqual([])
  })

  it('all providers succeed → succeeded N, failed 0', async () => {
    const result = await recordToAll(event(), {
      providers: [provider('a'), provider('b'), provider('c')],
    })
    expect(result.succeeded).toBe(3)
    expect(result.failed).toBe(0)
  })

  it('all providers fail → succeeded 0, failed N — never throws (fail-open)', async () => {
    const result = await recordToAll(event(), {
      providers: [provider('a', 'throw'), provider('b', 'throw')],
    })
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.failures.map(f => f.provider).sort()).toEqual(['a', 'b'])
  })

  it('mixed success / failure → counts split correctly', async () => {
    const result = await recordToAll(event(), {
      providers: [provider('history'), provider('cloudwatch', 'throw'), provider('webhook', 'throw')],
    })
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(2)
    expect(result.failures.map(f => f.provider).sort()).toEqual(['cloudwatch', 'webhook'])
  })

  it('failures are recorded in registration order (parallel-safe)', async () => {
    // Order of failures in the result mirrors provider array order
    // (Promise.allSettled preserves index-correspondence).
    const result = await recordToAll(event(), {
      providers: [provider('first', 'throw'), provider('second'), provider('third', 'throw')],
    })
    expect(result.failures.map(f => f.provider)).toEqual(['first', 'third'])
  })

  it('AuditTransportError category propagates to failure log', async () => {
    const result = await recordToAll(event(), {
      providers: [provider('a', 'transport-throw'), provider('b', 'serialize-throw')],
    })
    expect(result.failures.find(f => f.provider === 'a')?.category).toBe('transport')
    expect(result.failures.find(f => f.provider === 'b')?.category).toBe('serialize')
  })

  it('generic Error defaults to category: transport', async () => {
    const result = await recordToAll(event(), {
      providers: [provider('a', 'throw')],
    })
    expect(result.failures[0].category).toBe('transport')
  })

  it('logger receives one entry per failure', async () => {
    const log = vi.fn<(entry: AuditFailureLog) => void>()
    await recordToAll(event(), {
      providers: [provider('a', 'throw'), provider('b'), provider('c', 'throw')],
      logFailure: log,
    })
    expect(log).toHaveBeenCalledTimes(2)
    const calls = log.mock.calls.map(c => c[0])
    expect(calls.map(c => c.provider).sort()).toEqual(['a', 'c'])
  })

  it('logger entries do NOT contain the event payload', async () => {
    const log = vi.fn<(entry: AuditFailureLog) => void>()
    await recordToAll(event(), {
      providers: [provider('a', 'throw')],
      logFailure: log,
    })
    const entry = log.mock.calls[0][0]
    // The shape must be exactly { provider, category, reason }.
    // Adding the event payload would leak PII through stderr.
    expect(Object.keys(entry).sort()).toEqual(['category', 'provider', 'reason'])
    // Defense-in-depth: assert the actor's fields aren't on the entry.
    const json = JSON.stringify(entry)
    expect(json).not.toContain('alice')
    expect(json).not.toContain('editor')
    expect(json).not.toContain('home')
  })

  it('logger is optional (production should always wire one; tests can omit)', async () => {
    // No logger; provider failures still get counted but produce
    // no log output. This is intentional — silent failure is a
    // worse default than fail-open, but we let tests omit the
    // logger when they don't care about the log shape.
    const result = await recordToAll(event(), {
      providers: [provider('a', 'throw')],
    })
    expect(result.failed).toBe(1)
  })

  it('reason text comes from the thrown Error message', async () => {
    const result = await recordToAll(event(), {
      providers: [provider('cloudwatch', 'transport-throw')],
    })
    expect(result.failures[0].reason).toContain('connection refused')
  })

  it('providers are invoked in PARALLEL (not sequential)', async () => {
    // Parallel = Promise.allSettled; total time ≈ slowest provider,
    // not sum. With three providers each taking 50ms, sequential
    // execution would be ≥150ms; parallel should be <2x slowest.
    // We use a tracker to record start/end timestamps per provider
    // and assert overlap directly — avoids vitest timer-jitter
    // flakes in CI.
    const starts: Record<string, number> = {}
    const ends: Record<string, number> = {}
    const tracked = (name: string): AuditProvider => ({
      name,
      async record() {
        starts[name] = Date.now()
        await new Promise(r => setTimeout(r, 30))
        ends[name] = Date.now()
      },
    })
    await recordToAll(event(), {
      providers: [tracked('a'), tracked('b'), tracked('c')],
    })
    // All three started before any finished — that's the invariant
    // for parallel execution. Sequential would have started 'b'
    // only after 'a' finished.
    const allStarts = Math.max(starts.a, starts.b, starts.c)
    const firstEnd = Math.min(ends.a, ends.b, ends.c)
    expect(allStarts).toBeLessThanOrEqual(firstEnd)
  })

  it("strict mode is the CALLER's concern; recorder always returns the result", async () => {
    // The recorder doesn't act on `strict` — it returns the
    // result; the caller (Cut 5's handlers) checks result.failed
    // and aborts the write when strict is on. Test the recorder
    // doesn't behave differently with strict: true vs false.
    const a = await recordToAll(event(), { providers: [provider('x', 'throw')], strict: true })
    const b = await recordToAll(event(), { providers: [provider('x', 'throw')], strict: false })
    expect(a.failed).toBe(b.failed)
    expect(a.succeeded).toBe(b.succeeded)
  })
})
