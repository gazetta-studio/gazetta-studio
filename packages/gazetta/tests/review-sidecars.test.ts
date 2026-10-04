/**
 * Cut #517 tests — per-edge sidecar storage for review workflow.
 *
 * The sidecar module is pure I/O: encode path, read/write bytes.
 * These tests pin the acceptance bullets from the cut sub-issue:
 *
 *   - Write state, read it back; idempotent.
 *   - Independent per-approver sidecars (`approvers/alice`,
 *     `approvers/bob`) — no race.
 *   - Two instances writing different `approvers/` paths don't conflict.
 *
 * The last bullet is the load-bearing multi-instance correctness
 * invariant locked by `design-review-workflow.md`'s "Concurrent
 * approval race tolerance": per-edge granularity means two admin
 * instances approving the same submission write to different paths,
 * so there's no race to lose. We validate at both storage tiers:
 *
 *   - `memory` — fresh `memoryStorage()` default; proves the
 *     per-edge contract against the primary admin storage shape.
 *   - `fs` — real `createFilesystemProvider` + `tempDir`; proves the
 *     contract survives real filesystem semantics (POSIX directory
 *     listing, actual file writes, actual rm cascades). Required
 *     because the per-edge sidecar pattern depends on
 *     filesystem-shape atomicity for the multi-instance correctness
 *     guarantee to generalize to production.
 *
 * Per `testing-plan.md` "Storage tier": memory is the default; fs is
 * added here because this cut's acceptance explicitly names both
 * tiers (two-process no-conflict against both backends).
 */
import { mkdir, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import {
  decodeActorId,
  encodeActorId,
  readReviewApprovers,
  readReviewSidecar,
  removeReviewApprover,
  removeReviewSidecar,
  reviewApproverPath,
  reviewApproversDir,
  reviewScopeDir,
  reviewStatePath,
  writeReviewApprover,
  writeReviewSidecar,
  type ReviewScope,
  type ReviewSidecar,
} from '../src/review/index.js'
import type { StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

type Tier = {
  readonly name: 'memory' | 'fs'
  readonly setup: () => Promise<{
    readonly storage: StorageProvider
    readonly dispose: () => Promise<void>
  }>
}

const tiers: readonly Tier[] = [
  {
    name: 'memory',
    setup: async () => {
      const storage = memoryStorage()
      return { storage, dispose: async () => {} }
    },
  },
  {
    name: 'fs',
    setup: async () => {
      const dir = tempDir(`review-sidecars-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      await mkdir(dir, { recursive: true })
      const storage = createFilesystemProvider(dir)
      return {
        storage,
        dispose: async () => {
          await rm(dir, { recursive: true, force: true })
        },
      }
    },
  },
]

const pageScope: ReviewScope = { kind: 'page', name: 'home' }
const fragmentScope: ReviewScope = { kind: 'fragment', name: 'header' }
const nestedPageScope: ReviewScope = { kind: 'page', name: 'blog/[slug]' }

function pendingSidecar(overrides: Partial<ReviewSidecar> = {}): ReviewSidecar {
  return {
    state: 'pending-review',
    stateChangedAt: '2026-10-04T10:00:00.000Z',
    submitter: 'alice',
    submittedAt: '2026-10-04T10:00:00.000Z',
    requiredApprovers: 2,
    approvers: [],
    ...overrides,
  }
}

describe('encodeActorId / decodeActorId', () => {
  it('round-trips email-shaped actor IDs', () => {
    const id = 'alice@example.com'
    expect(decodeActorId(encodeActorId(id))).toBe(id)
  })

  it('encodes characters that would collide with path separators or filesystem specials', () => {
    const id = 'alice@example.com'
    const encoded = encodeActorId(id)
    // At minimum, @ should be percent-encoded so the sidecar name can't
    // be mistaken for a mail-user:// URL on some systems.
    expect(encoded).not.toContain('@')
    expect(encoded).toBe('alice%40example.com')
  })

  it('encodes slashes so an actor ID can never be mistaken for a path segment', () => {
    const id = 'okta/user-123'
    const encoded = encodeActorId(id)
    expect(encoded).not.toContain('/')
    expect(decodeActorId(encoded)).toBe(id)
  })

  it('round-trips unicode actor IDs', () => {
    const id = 'ユーザー-α'
    expect(decodeActorId(encodeActorId(id))).toBe(id)
  })
})

describe('reviewScopeDir / reviewStatePath / reviewApproversDir / reviewApproverPath', () => {
  it('places the state file under `.gazetta/review/{kind}s/{name}/state.json`', () => {
    const storage = memoryStorage()
    const root = createContentRoot(storage)
    expect(reviewStatePath(root, pageScope)).toBe('.gazetta/review/pages/home/state.json')
    expect(reviewStatePath(root, fragmentScope)).toBe('.gazetta/review/fragments/header/state.json')
  })

  it('pluralizes kind in the path (pages / fragments)', () => {
    const root = createContentRoot(memoryStorage())
    expect(reviewScopeDir(root, pageScope)).toContain('/pages/')
    expect(reviewScopeDir(root, fragmentScope)).toContain('/fragments/')
  })

  it('encodes slashes in the item name via encodeRefName (dots per the ref-name convention)', () => {
    const root = createContentRoot(memoryStorage())
    // encodeRefName turns `blog/[slug]` into `blog.[slug]` — slashes
    // become dots per the house convention. If the storage layer
    // doesn't tolerate `[` or `]`, that's a separate concern (every
    // existing sidecar passes it through).
    expect(reviewStatePath(root, nestedPageScope)).toBe('.gazetta/review/pages/blog.[slug]/state.json')
  })

  it('places approver sidecars under `.../approvers/{encoded-actor}`', () => {
    const root = createContentRoot(memoryStorage())
    expect(reviewApproversDir(root, pageScope)).toBe('.gazetta/review/pages/home/approvers')
    expect(reviewApproverPath(root, pageScope, 'alice@example.com')).toBe(
      '.gazetta/review/pages/home/approvers/alice%40example.com',
    )
  })

  it('composes with ContentRoot rootPath prefix', () => {
    const storage = memoryStorage()
    const root = createContentRoot(storage, 'sites/main')
    expect(reviewStatePath(root, pageScope)).toBe('sites/main/.gazetta/review/pages/home/state.json')
    expect(reviewApproverPath(root, pageScope, 'alice')).toBe('sites/main/.gazetta/review/pages/home/approvers/alice')
  })
})

describe.each(tiers)('sidecar round-trip ($name storage)', ({ setup }) => {
  let storage: StorageProvider
  let dispose: () => Promise<void>

  beforeEach(async () => {
    const t = await setup()
    storage = t.storage
    dispose = t.dispose
  })

  afterEach(async () => {
    await dispose()
  })

  describe('readReviewSidecar / writeReviewSidecar', () => {
    it('returns null when no sidecar exists (default draft state)', async () => {
      const root = createContentRoot(storage)
      expect(await readReviewSidecar(root, pageScope)).toBeNull()
    })

    it('writes a sidecar and reads it back verbatim', async () => {
      const root = createContentRoot(storage)
      const sidecar = pendingSidecar()
      await writeReviewSidecar(root, pageScope, sidecar)
      const read = await readReviewSidecar(root, pageScope)
      expect(read).toEqual(sidecar)
    })

    it('round-trips an approved sidecar with per-approver comments', async () => {
      const root = createContentRoot(storage)
      const sidecar: ReviewSidecar = {
        state: 'approved',
        stateChangedAt: '2026-10-04T11:00:00.000Z',
        submitter: 'alice',
        submittedAt: '2026-10-04T10:00:00.000Z',
        requiredApprovers: 2,
        approvedAt: '2026-10-04T11:00:00.000Z',
        approvers: [
          { actor: 'bob', approvedAt: '2026-10-04T10:30:00.000Z', comment: 'LGTM' },
          { actor: 'carol', approvedAt: '2026-10-04T11:00:00.000Z' },
        ],
      }
      await writeReviewSidecar(root, pageScope, sidecar)
      expect(await readReviewSidecar(root, pageScope)).toEqual(sidecar)
    })

    it('is idempotent — rewriting the same sidecar leaves the stored shape unchanged', async () => {
      const root = createContentRoot(storage)
      const sidecar = pendingSidecar()
      await writeReviewSidecar(root, pageScope, sidecar)
      await writeReviewSidecar(root, pageScope, sidecar)
      await writeReviewSidecar(root, pageScope, sidecar)
      expect(await readReviewSidecar(root, pageScope)).toEqual(sidecar)
    })

    it('overwrites existing state with a new snapshot (last-write-wins)', async () => {
      const root = createContentRoot(storage)
      await writeReviewSidecar(root, pageScope, pendingSidecar())
      const approved: ReviewSidecar = {
        state: 'approved',
        stateChangedAt: '2026-10-04T11:00:00.000Z',
        submitter: 'alice',
        submittedAt: '2026-10-04T10:00:00.000Z',
        requiredApprovers: 2,
        approvedAt: '2026-10-04T11:00:00.000Z',
        approvers: [
          { actor: 'bob', approvedAt: '2026-10-04T10:30:00.000Z' },
          { actor: 'carol', approvedAt: '2026-10-04T11:00:00.000Z' },
        ],
      }
      await writeReviewSidecar(root, pageScope, approved)
      expect(await readReviewSidecar(root, pageScope)).toEqual(approved)
    })

    it('keeps page and fragment sidecars at the same name separate', async () => {
      // `pages/home` and `fragments/home` must not collide — the kind
      // dir disambiguates. If they shared storage, approving the page
      // would surface as approving the fragment too, which would be a
      // nasty cross-domain bug.
      const root = createContentRoot(storage)
      const pageSidecar = pendingSidecar({ submitter: 'alice' })
      const fragmentSidecar = pendingSidecar({ submitter: 'bob' })
      await writeReviewSidecar(root, { kind: 'page', name: 'home' }, pageSidecar)
      await writeReviewSidecar(root, { kind: 'fragment', name: 'home' }, fragmentSidecar)
      expect(await readReviewSidecar(root, { kind: 'page', name: 'home' })).toEqual(pageSidecar)
      expect(await readReviewSidecar(root, { kind: 'fragment', name: 'home' })).toEqual(fragmentSidecar)
    })
  })

  describe('removeReviewSidecar', () => {
    it('clears state.json and the approvers directory in one call', async () => {
      const root = createContentRoot(storage)
      await writeReviewSidecar(root, pageScope, pendingSidecar())
      await writeReviewApprover(root, pageScope, 'bob')
      await writeReviewApprover(root, pageScope, 'carol')
      await removeReviewSidecar(root, pageScope)
      expect(await readReviewSidecar(root, pageScope)).toBeNull()
      expect(await readReviewApprovers(root, pageScope)).toEqual([])
    })

    it('is idempotent — removing an already-gone sidecar is a no-op', async () => {
      const root = createContentRoot(storage)
      await removeReviewSidecar(root, pageScope)
      await removeReviewSidecar(root, pageScope)
      expect(await readReviewSidecar(root, pageScope)).toBeNull()
    })

    it('does not touch siblings (removing page home leaves fragment home untouched)', async () => {
      const root = createContentRoot(storage)
      const pageSidecar = pendingSidecar({ submitter: 'alice' })
      const fragmentSidecar = pendingSidecar({ submitter: 'bob' })
      await writeReviewSidecar(root, { kind: 'page', name: 'home' }, pageSidecar)
      await writeReviewSidecar(root, { kind: 'fragment', name: 'home' }, fragmentSidecar)
      await removeReviewSidecar(root, { kind: 'page', name: 'home' })
      expect(await readReviewSidecar(root, { kind: 'page', name: 'home' })).toBeNull()
      expect(await readReviewSidecar(root, { kind: 'fragment', name: 'home' })).toEqual(fragmentSidecar)
    })
  })

  describe('writeReviewApprover / readReviewApprovers', () => {
    it('returns an empty list when no approvers directory exists', async () => {
      const root = createContentRoot(storage)
      expect(await readReviewApprovers(root, pageScope)).toEqual([])
    })

    it('writes a zero-byte sidecar and surfaces the actor via readDir', async () => {
      const root = createContentRoot(storage)
      await writeReviewApprover(root, pageScope, 'alice')
      const bytes = await storage.readFile(reviewApproverPath(root, pageScope, 'alice'))
      expect(bytes).toBe('')
      expect(await readReviewApprovers(root, pageScope)).toEqual(['alice'])
    })

    it('records multiple independent approvers; readDir returns all of them', async () => {
      const root = createContentRoot(storage)
      await writeReviewApprover(root, pageScope, 'alice')
      await writeReviewApprover(root, pageScope, 'bob')
      await writeReviewApprover(root, pageScope, 'carol')
      const approvers = await readReviewApprovers(root, pageScope)
      // Order isn't contracted (filesystem returns alphabetical;
      // cloud providers may differ). Compare as sets.
      expect(new Set(approvers)).toEqual(new Set(['alice', 'bob', 'carol']))
    })

    it('is idempotent — writing the same approver twice does not duplicate the entry', async () => {
      const root = createContentRoot(storage)
      await writeReviewApprover(root, pageScope, 'alice')
      await writeReviewApprover(root, pageScope, 'alice')
      await writeReviewApprover(root, pageScope, 'alice')
      expect(await readReviewApprovers(root, pageScope)).toEqual(['alice'])
    })

    it('round-trips email-shaped actor IDs through the sidecar directory', async () => {
      const root = createContentRoot(storage)
      await writeReviewApprover(root, pageScope, 'alice@example.com')
      expect(await readReviewApprovers(root, pageScope)).toEqual(['alice@example.com'])
    })

    it('round-trips OIDC-sub-shaped IDs (dots + hyphens)', async () => {
      const root = createContentRoot(storage)
      const subs = ['auth0|507f1f77bcf86cd799439011', 'okta-dev-123.ok.example.com', 'bob@example.com']
      for (const id of subs) await writeReviewApprover(root, pageScope, id)
      expect(new Set(await readReviewApprovers(root, pageScope))).toEqual(new Set(subs))
    })

    it('removes one approver without touching peers', async () => {
      const root = createContentRoot(storage)
      await writeReviewApprover(root, pageScope, 'alice')
      await writeReviewApprover(root, pageScope, 'bob')
      await removeReviewApprover(root, pageScope, 'alice')
      expect(await readReviewApprovers(root, pageScope)).toEqual(['bob'])
    })

    it('removeReviewApprover is idempotent — removing an already-gone approver is a no-op', async () => {
      const root = createContentRoot(storage)
      await writeReviewApprover(root, pageScope, 'alice')
      await removeReviewApprover(root, pageScope, 'alice')
      await removeReviewApprover(root, pageScope, 'alice')
      expect(await readReviewApprovers(root, pageScope)).toEqual([])
    })
  })

  describe('multi-instance / per-edge granularity', () => {
    it('two independent ContentRoot handles on the same backing storage write different approver paths without conflict', async () => {
      // Multi-instance correctness proxy: two admin instances sharing
      // one storage (R2 / S3 / Azure / shared filesystem). Each
      // instance's save handler sees its own ContentRoot wrapper but
      // the same underlying bytes. Writing DIFFERENT per-approver
      // paths must not race.
      const rootA = createContentRoot(storage)
      const rootB = createContentRoot(storage)

      // Concurrently approve from two "instances" against the same scope.
      await Promise.all([writeReviewApprover(rootA, pageScope, 'alice'), writeReviewApprover(rootB, pageScope, 'bob')])

      // Both approvals surface regardless of which instance reads.
      const asReadByA = new Set(await readReviewApprovers(rootA, pageScope))
      const asReadByB = new Set(await readReviewApprovers(rootB, pageScope))
      expect(asReadByA).toEqual(new Set(['alice', 'bob']))
      expect(asReadByB).toEqual(new Set(['alice', 'bob']))
    })

    it('concurrent writes to the same (scope, actor) pair converge (idempotent)', async () => {
      // Even same-path writes are safe — same bytes (empty), last
      // write wins trivially.
      const rootA = createContentRoot(storage)
      const rootB = createContentRoot(storage)
      await Promise.all([
        writeReviewApprover(rootA, pageScope, 'alice'),
        writeReviewApprover(rootB, pageScope, 'alice'),
      ])
      expect(await readReviewApprovers(rootA, pageScope)).toEqual(['alice'])
    })

    it('a flurry of concurrent writes to distinct approver paths all land', async () => {
      // Stress-test the per-edge granularity: 10 instances approving
      // 10 different actors on the same scope must all land.
      const roots = Array.from({ length: 10 }, () => createContentRoot(storage))
      const actors = Array.from({ length: 10 }, (_, i) => `user-${i}@example.com`)
      await Promise.all(roots.map((r, i) => writeReviewApprover(r, pageScope, actors[i]!)))
      const read = new Set(await readReviewApprovers(roots[0]!, pageScope))
      expect(read).toEqual(new Set(actors))
    })
  })
})
