/**
 * Cut 8 tests: pruneAuditEvents.
 *
 * Pins the retention semantics from design-audit.md "Retention":
 *
 *   - `events` cap (max count) — global across all per-instance JSONL
 *     files, oldest evicted
 *   - `maxAgeMonths` cap — events older than the cutoff evicted
 *   - both set — age cutoff first, then count cap on what remains
 *   - neither set — no-op
 *   - empty / missing audit dir — no-op
 *   - malformed JSONL lines — skipped (don't poison the rewrite)
 *   - empty file after prune → written as empty (preserves the file
 *     marker; concurrent appenders don't need to mkdir)
 *   - per-file rewrite — only files with at least one eviction
 *     rewrite (avoids dirtying mtime on unaffected files)
 *
 * Storage: in-memory backed StorageProvider; no real filesystem,
 * keeps tests fast + deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { pruneAuditEvents } from '../src/audit/retention.js'
import type { AuditEvent } from '../src/audit/types.js'

function makeEvent(timestamp: string, partial: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp,
    actor: { id: 'alice', role: 'admin', trustMode: 'none' },
    action: 'save',
    outcome: 'success',
    scope: { kind: 'page', name: 'home' },
    ...partial,
  }
}

describe('Cut 8 — pruneAuditEvents', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-retention-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Each test gets its own subdir under the temp dir to avoid cross-
  // test interference. The storage provider treats `path` as the
  // root prefix for relative ops.
  let counter = 0
  function newStorage() {
    counter++
    const root = join(dir, `t-${counter}`)
    return { storage: createFilesystemProvider(root), root }
  }

  async function writeEvents(
    storage: ReturnType<typeof newStorage>['storage'],
    instance: string,
    events: AuditEvent[],
  ): Promise<void> {
    await storage.mkdir('.gazetta/audit').catch(() => {})
    const content = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
    await storage.writeFile(`.gazetta/audit/events-${instance}.jsonl`, content)
  }

  async function readEvents(
    storage: ReturnType<typeof newStorage>['storage'],
    instance: string,
  ): Promise<AuditEvent[]> {
    const content = await storage.readFile(`.gazetta/audit/events-${instance}.jsonl`)
    if (!content) return []
    return content
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => JSON.parse(l) as AuditEvent)
  }

  describe('no-op cases', () => {
    it('returns zero metrics when neither retention dimension is set', async () => {
      const { storage } = newStorage()
      await writeEvents(storage, 'a', [makeEvent('2026-05-04T10:00:00Z'), makeEvent('2026-05-04T11:00:00Z')])
      const result = await pruneAuditEvents(storage, {})
      expect(result.eventsBefore).toBe(0)
      expect(result.eventsKept).toBe(0)
      expect(result.eventsEvicted).toBe(0)
      expect(result.filesRewritten).toBe(0)
      // Events still present (no-op didn't touch them)
      const surviving = await readEvents(storage, 'a')
      expect(surviving).toHaveLength(2)
    })

    it('handles missing audit directory', async () => {
      const { storage } = newStorage()
      const result = await pruneAuditEvents(storage, { events: 100 })
      expect(result.eventsBefore).toBe(0)
      expect(result.eventsEvicted).toBe(0)
      expect(result.filesInspected).toBe(0)
    })

    it('handles empty audit directory', async () => {
      const { storage } = newStorage()
      await storage.mkdir('.gazetta/audit')
      const result = await pruneAuditEvents(storage, { events: 100 })
      expect(result.eventsBefore).toBe(0)
      expect(result.filesInspected).toBe(0)
    })
  })

  describe('events cap (count-based)', () => {
    it('evicts oldest when count exceeds cap', async () => {
      const { storage } = newStorage()
      await writeEvents(storage, 'a', [
        makeEvent('2026-05-04T10:00:00Z', { scope: { kind: 'page', name: 'a' } }),
        makeEvent('2026-05-04T11:00:00Z', { scope: { kind: 'page', name: 'b' } }),
        makeEvent('2026-05-04T12:00:00Z', { scope: { kind: 'page', name: 'c' } }),
        makeEvent('2026-05-04T13:00:00Z', { scope: { kind: 'page', name: 'd' } }),
        makeEvent('2026-05-04T14:00:00Z', { scope: { kind: 'page', name: 'e' } }),
      ])
      const result = await pruneAuditEvents(storage, { events: 3 })
      expect(result.eventsBefore).toBe(5)
      expect(result.eventsKept).toBe(3)
      expect(result.eventsEvicted).toBe(2)
      expect(result.filesRewritten).toBe(1)
      const surviving = await readEvents(storage, 'a')
      expect(surviving.map(e => e.scope.name)).toEqual(['c', 'd', 'e'])
    })

    it('evicts oldest globally across multiple instance files', async () => {
      const { storage } = newStorage()
      // Instance 'a' has older events; instance 'b' has newer.
      // Cap = 3 → keeps the 3 newest globally, regardless of which file.
      await writeEvents(storage, 'a', [
        makeEvent('2026-05-04T10:00:00Z', { scope: { kind: 'page', name: 'a-old' } }),
        makeEvent('2026-05-04T11:00:00Z', { scope: { kind: 'page', name: 'a-mid' } }),
      ])
      await writeEvents(storage, 'b', [
        makeEvent('2026-05-04T13:00:00Z', { scope: { kind: 'page', name: 'b-old' } }),
        makeEvent('2026-05-04T14:00:00Z', { scope: { kind: 'page', name: 'b-mid' } }),
        makeEvent('2026-05-04T15:00:00Z', { scope: { kind: 'page', name: 'b-new' } }),
      ])
      const result = await pruneAuditEvents(storage, { events: 3 })
      expect(result.eventsKept).toBe(3)
      expect(result.eventsEvicted).toBe(2)
      // Both files modified — the two oldest came from 'a'.
      const survivingA = await readEvents(storage, 'a')
      const survivingB = await readEvents(storage, 'b')
      expect(survivingA).toHaveLength(0)
      expect(survivingB.map(e => e.scope.name)).toEqual(['b-old', 'b-mid', 'b-new'])
    })

    it('no rewrites when count is within cap', async () => {
      const { storage } = newStorage()
      await writeEvents(storage, 'a', [makeEvent('2026-05-04T10:00:00Z'), makeEvent('2026-05-04T11:00:00Z')])
      const result = await pruneAuditEvents(storage, { events: 100 })
      expect(result.eventsBefore).toBe(2)
      expect(result.eventsEvicted).toBe(0)
      expect(result.filesRewritten).toBe(0)
    })
  })

  describe('maxAgeMonths cap (age-based)', () => {
    it('evicts events older than the cutoff', async () => {
      const { storage } = newStorage()
      const now = new Date()
      const oldEnough = new Date()
      oldEnough.setMonth(oldEnough.getMonth() - 3)
      const recent = new Date()
      recent.setMonth(recent.getMonth() - 1)

      await writeEvents(storage, 'a', [
        makeEvent(oldEnough.toISOString(), { scope: { kind: 'page', name: 'old' } }),
        makeEvent(recent.toISOString(), { scope: { kind: 'page', name: 'recent' } }),
        makeEvent(now.toISOString(), { scope: { kind: 'page', name: 'now' } }),
      ])
      // Cutoff = 2 months back → 'old' evicted, 'recent' + 'now' kept.
      const result = await pruneAuditEvents(storage, { maxAgeMonths: 2 })
      expect(result.eventsBefore).toBe(3)
      expect(result.eventsKept).toBe(2)
      expect(result.eventsEvicted).toBe(1)
      const surviving = await readEvents(storage, 'a')
      expect(surviving.map(e => e.scope.name).sort()).toEqual(['now', 'recent'])
    })

    it('null / 0 / undefined maxAgeMonths is a no-op for the age dimension', async () => {
      const { storage } = newStorage()
      const ancient = new Date()
      ancient.setMonth(ancient.getMonth() - 24)
      await writeEvents(storage, 'a', [makeEvent(ancient.toISOString(), { scope: { kind: 'page', name: 'a' } })])
      const r1 = await pruneAuditEvents(storage, { maxAgeMonths: null })
      expect(r1.eventsBefore).toBe(0) // neither dimension set → full no-op
      const r2 = await pruneAuditEvents(storage, { maxAgeMonths: 0 })
      // 0 months is treated as no-op (positive int required per schema;
      // pruner is defensive against zero anyway).
      expect(r2.eventsEvicted).toBe(0)
    })
  })

  describe('combined dimensions', () => {
    it('applies age cutoff first, then count cap on what remains', async () => {
      const { storage } = newStorage()
      const old = new Date()
      old.setMonth(old.getMonth() - 6)
      const t1 = new Date()
      t1.setMonth(t1.getMonth() - 1)
      const t2 = new Date()
      t2.setHours(t2.getHours() - 2)
      const t3 = new Date()
      t3.setHours(t3.getHours() - 1)
      const t4 = new Date()

      await writeEvents(storage, 'a', [
        makeEvent(old.toISOString(), { scope: { kind: 'page', name: 'old' } }),
        makeEvent(t1.toISOString(), { scope: { kind: 'page', name: 't1' } }),
        makeEvent(t2.toISOString(), { scope: { kind: 'page', name: 't2' } }),
        makeEvent(t3.toISOString(), { scope: { kind: 'page', name: 't3' } }),
        makeEvent(t4.toISOString(), { scope: { kind: 'page', name: 't4' } }),
      ])
      // maxAgeMonths=3 → drops 'old' (6 months back).
      // events=2 → keeps the 2 newest of the survivors {t1, t2, t3, t4}
      // → {t3, t4}.
      const result = await pruneAuditEvents(storage, { maxAgeMonths: 3, events: 2 })
      expect(result.eventsBefore).toBe(5)
      expect(result.eventsKept).toBe(2)
      expect(result.eventsEvicted).toBe(3)
      const surviving = await readEvents(storage, 'a')
      expect(surviving.map(e => e.scope.name).sort()).toEqual(['t3', 't4'])
    })
  })

  describe('robustness', () => {
    it('skips malformed JSONL lines without poisoning the rewrite', async () => {
      const { storage } = newStorage()
      await storage.mkdir('.gazetta/audit')
      // Mix valid + malformed lines. The reader skips the bad one,
      // the rewriter doesn't include it in surviving.
      const valid1 = JSON.stringify(makeEvent('2026-05-04T10:00:00Z', { scope: { kind: 'page', name: 'a' } }))
      const valid2 = JSON.stringify(makeEvent('2026-05-04T11:00:00Z', { scope: { kind: 'page', name: 'b' } }))
      await storage.writeFile('.gazetta/audit/events-a.jsonl', `${valid1}\n{ broken json no closing brace\n${valid2}\n`)
      const result = await pruneAuditEvents(storage, { events: 1 })
      // 2 valid events present (malformed line skipped at parse).
      // Cap=1 → keep newest, evict 'a'. The rawLineCount counted the
      // malformed line, so eventsEvicted = rawLineCount - surviving =
      // 3 - 1 = 2 (the old valid + the malformed line).
      expect(result.eventsBefore).toBe(2)
      expect(result.eventsKept).toBe(1)
      const surviving = await readEvents(storage, 'a')
      expect(surviving).toHaveLength(1)
      expect(surviving[0].scope.name).toBe('b')
    })

    it('writes empty file when all events evicted', async () => {
      const { storage } = newStorage()
      const old = new Date()
      old.setMonth(old.getMonth() - 12)
      await writeEvents(storage, 'a', [makeEvent(old.toISOString(), { scope: { kind: 'page', name: 'old' } })])
      const result = await pruneAuditEvents(storage, { maxAgeMonths: 1 })
      expect(result.eventsKept).toBe(0)
      expect(result.eventsEvicted).toBe(1)
      // File still exists (empty), not deleted.
      const content = await storage.readFile('.gazetta/audit/events-a.jsonl')
      expect(content).toBe('')
    })

    it('only rewrites files that had at least one eviction', async () => {
      const { storage } = newStorage()
      await writeEvents(storage, 'a', [makeEvent('2026-05-04T10:00:00Z'), makeEvent('2026-05-04T11:00:00Z')])
      await writeEvents(storage, 'b', [
        makeEvent('2026-05-04T15:00:00Z'),
        makeEvent('2026-05-04T16:00:00Z'),
        makeEvent('2026-05-04T17:00:00Z'),
      ])
      // Cap=4 → only one event evicted (the oldest from 'a').
      const result = await pruneAuditEvents(storage, { events: 4 })
      expect(result.eventsEvicted).toBe(1)
      expect(result.filesRewritten).toBe(1)
      expect(result.filesInspected).toBe(2)
    })
  })
})
