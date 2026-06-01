/**
 * Failing test (rule 31 TDD-first) for the audit retention pruner
 * failure-signal contract.
 *
 * Before fix: the catch block in admin-api/index.ts:490 swallowed
 * pruneAuditEvents failures silently — the TODO comment explicitly
 * said this was waiting for the logging foundation (design-logging.md
 * has shipped as a design; pruner failures are the operational signal
 * operators need to detect drift).
 *
 * After fix: pruner failures emit a structured failure log entry
 * (matches the cache-stats-logger.ts pattern — structured JSON via
 * console with a sink seam for tests; both anchor the same interim
 * convention until `gazetta/logging` ships).
 *
 * Universal Provider Requirement #5 still holds: failures never throw;
 * audit accumulates until the next successful prune. The fix adds the
 * signal without changing the fail-open behavior.
 */
import { describe, expect, it } from 'vitest'
import type { DirEntry, StorageProvider } from '../src/types.js'
import { runAuditPrune, type AuditPruneFailureLogEntry } from '../src/admin-api/audit-prune-runner.js'

/**
 * Storage stub that succeeds at `readDir('.gazetta/audit')` (returns
 * one events file entry) but throws on `readFile` — drives
 * `pruneAuditEvents` past its missing-dir short-circuit into the
 * read-line path where the throw escapes.
 */
function brokenAuditStorage(): StorageProvider {
  return {
    async readDir(path: string): Promise<DirEntry[]> {
      if (path === '.gazetta/audit') {
        return [{ name: 'events-test.jsonl', isDirectory: false }]
      }
      return []
    },
    async readFile(): Promise<string> {
      throw new Error('storage unavailable')
    },
    async writeFile(): Promise<void> {
      throw new Error('storage unavailable')
    },
    async exists(): Promise<boolean> {
      return false
    },
    async mkdir(): Promise<void> {},
    async rm(): Promise<void> {},
    async readBytes(): Promise<Uint8Array> {
      throw new Error('storage unavailable')
    },
    async writeBytes(): Promise<void> {
      throw new Error('storage unavailable')
    },
    async readStream(): Promise<ReadableStream<Uint8Array>> {
      throw new Error('storage unavailable')
    },
    async writeStream(): Promise<void> {
      throw new Error('storage unavailable')
    },
  }
}

describe('runAuditPrune', () => {
  it('emits a structured failure log when pruneAuditEvents throws and fails open', async () => {
    const entries: AuditPruneFailureLogEntry[] = []

    // Must not throw — Universal Provider Requirement #5 (fail-open).
    await runAuditPrune({
      storage: brokenAuditStorage(),
      retentionConfig: { events: 10 },
      sink: e => entries.push(e),
    })

    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.level).toBe('error')
    expect(entry.module).toBe('admin-api.audit-prune')
    expect(entry.message).toContain('Audit retention pruner failed')
    expect(entry.err.message).toBe('storage unavailable')
    // ISO 8601 with Z suffix per design-logging.md convention.
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('does not emit a log entry on successful prune', async () => {
    const entries: AuditPruneFailureLogEntry[] = []
    // Empty / missing audit dir — pruneAuditEvents returns a no-op
    // result without touching readFile/writeFile.
    const emptyStorage: StorageProvider = {
      async readDir(): Promise<DirEntry[]> {
        return []
      },
      async readFile(): Promise<string> {
        return ''
      },
      async writeFile(): Promise<void> {},
      async exists(): Promise<boolean> {
        return false
      },
      async mkdir(): Promise<void> {},
      async rm(): Promise<void> {},
      async readBytes(): Promise<Uint8Array> {
        return new Uint8Array()
      },
      async writeBytes(): Promise<void> {},
      async readStream(): Promise<ReadableStream<Uint8Array>> {
        throw new Error('unused')
      },
      async writeStream(): Promise<void> {},
    }

    await runAuditPrune({
      storage: emptyStorage,
      retentionConfig: { events: 10 },
      sink: e => entries.push(e),
    })

    expect(entries).toHaveLength(0)
  })
})
