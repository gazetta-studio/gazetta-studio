/**
 * Cut 3 of `design-review-workflow.md`: per-edge sidecar storage for
 * content review state. Tests pin the storage layer's contract:
 *
 *   - state.json round-trips through write + read with field fidelity
 *   - writes are idempotent (same input → same final state)
 *   - per-approver sidecars at distinct paths don't race; two parallel
 *     `recordApprover` calls for different actors land both files
 *   - actor ids round-trip through filesystem encoding (covers emails,
 *     OIDC subs, anything `encodeURIComponent` survives)
 *   - subfolder manifest names (`blog/[slug]`) collapse safely through
 *     `encodeRefName` — keeps the path tree flat at one directory level
 *   - both `memoryStorage()` and the real filesystem provider satisfy
 *     the contract — the storage primitive doesn't lean on provider-
 *     specific atomicity guarantees beyond what `StorageProvider`
 *     promises
 */
import { describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import {
  approverPath,
  approversDir,
  clearApprovers,
  readApprovers,
  readReviewState,
  recordApprover,
  reviewStatePath,
  writeReviewState,
} from '../src/review/sidecars.js'
import type { ContentRoot } from '../src/content-root.js'
import type { ManifestKey, ReviewSidecar } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const PAGE_HOME: ManifestKey = { kind: 'page', name: 'home' }
const FRAGMENT_HEADER: ManifestKey = { kind: 'fragment', name: 'header' }

interface RootFactory {
  name: string
  create(): Promise<{ root: ContentRoot; cleanup(): Promise<void> }>
}

function memRoot(): RootFactory {
  return {
    name: 'memory',
    async create() {
      const root = createContentRoot(memoryStorage(), '')
      return { root, cleanup: async () => {} }
    },
  }
}

const fsTempName = `review-sidecars-${Date.now()}`

function fsRoot(): RootFactory {
  return {
    name: 'filesystem',
    async create() {
      const dir = tempDir(`${fsTempName}-${Math.random().toString(36).slice(2, 10)}`)
      await mkdir(dir, { recursive: true })
      const root = createContentRoot(createFilesystemProvider(dir), '')
      return {
        root,
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true })
        },
      }
    },
  }
}

const tiers = [memRoot(), fsRoot()]

describe('path helpers', () => {
  const root = createContentRoot(memoryStorage(), '')

  it('puts pages and fragments under distinct kind segments', () => {
    expect(reviewStatePath(root, { kind: 'page', name: 'home' })).toBe('.gazetta/review/pages/home/state.json')
    expect(reviewStatePath(root, { kind: 'fragment', name: 'header' })).toBe(
      '.gazetta/review/fragments/header/state.json',
    )
  })

  it('encodes subfolder manifest names so the path tree stays flat at the item level', () => {
    expect(reviewStatePath(root, { kind: 'page', name: 'blog/[slug]' })).toBe(
      '.gazetta/review/pages/blog.[slug]/state.json',
    )
  })

  it('places per-approver sidecars under the item-scoped approvers/ directory', () => {
    expect(approversDir(root, PAGE_HOME)).toBe('.gazetta/review/pages/home/approvers')
    expect(approverPath(root, PAGE_HOME, 'alice')).toBe('.gazetta/review/pages/home/approvers/alice')
  })

  it('encodes actor ids so email / OIDC sub identities yield filesystem-safe filenames', () => {
    expect(approverPath(root, PAGE_HOME, 'alice@example.com')).toBe(
      '.gazetta/review/pages/home/approvers/alice%40example.com',
    )
    expect(approverPath(root, PAGE_HOME, 'sub|abc/def')).toBe('.gazetta/review/pages/home/approvers/sub%7Cabc%2Fdef')
  })

  it('rejects manifest names containing `.` via the shared encodeRefName guard', () => {
    expect(() => reviewStatePath(root, { kind: 'page', name: 'bad.name' })).toThrow(/dot is reserved/)
  })
})

for (const tier of tiers) {
  describe(`review state I/O (${tier.name})`, () => {
    it('returns null when no state.json has been written', async () => {
      const { root, cleanup } = await tier.create()
      try {
        expect(await readReviewState(root, PAGE_HOME)).toBeNull()
      } finally {
        await cleanup()
      }
    })

    it('round-trips a full sidecar (all fields) through write + read', async () => {
      const { root, cleanup } = await tier.create()
      try {
        const state: ReviewSidecar = {
          state: 'approved',
          submittedAt: '2026-06-07T10:00:00.000Z',
          submittedBy: 'alice@example.com',
          approvedAt: '2026-06-07T11:30:00.000Z',
          requiredApprovers: 2,
          approverComments: {
            'alice@example.com': 'LGTM',
            'bob@example.com': 'Minor concern about copy',
          },
        }
        await writeReviewState(root, PAGE_HOME, state)
        expect(await readReviewState(root, PAGE_HOME)).toEqual(state)
      } finally {
        await cleanup()
      }
    })

    it('round-trips a minimal sidecar (just state) — optional fields stay absent', async () => {
      const { root, cleanup } = await tier.create()
      try {
        const state: ReviewSidecar = { state: 'draft' }
        await writeReviewState(root, PAGE_HOME, state)
        const read = await readReviewState(root, PAGE_HOME)
        expect(read).toEqual({ state: 'draft' })
        // Confirm the optional fields weren't materialized.
        expect(read).not.toHaveProperty('submittedAt')
        expect(read).not.toHaveProperty('approverComments')
      } finally {
        await cleanup()
      }
    })

    it('is idempotent — writing the same state twice leaves the same final result', async () => {
      const { root, cleanup } = await tier.create()
      try {
        const state: ReviewSidecar = {
          state: 'pending-review',
          submittedAt: '2026-06-07T10:00:00.000Z',
          submittedBy: 'alice',
          requiredApprovers: 1,
        }
        await writeReviewState(root, PAGE_HOME, state)
        await writeReviewState(root, PAGE_HOME, state)
        expect(await readReviewState(root, PAGE_HOME)).toEqual(state)
      } finally {
        await cleanup()
      }
    })

    it('replaces prior state on subsequent write (last-write-wins)', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await writeReviewState(root, PAGE_HOME, { state: 'draft' })
        await writeReviewState(root, PAGE_HOME, {
          state: 'pending-review',
          submittedBy: 'alice',
          submittedAt: '2026-06-07T10:00:00.000Z',
          requiredApprovers: 1,
        })
        const read = await readReviewState(root, PAGE_HOME)
        expect(read?.state).toBe('pending-review')
        expect(read?.submittedBy).toBe('alice')
      } finally {
        await cleanup()
      }
    })

    it('keeps page and fragment state independent under the same item name', async () => {
      const { root, cleanup } = await tier.create()
      try {
        const pageState: ReviewSidecar = { state: 'approved' }
        const fragState: ReviewSidecar = { state: 'pending-review', submittedBy: 'bob' }
        // Use the same `name` for both kinds — the `kind` segment is what
        // keeps them apart in storage.
        await writeReviewState(root, { kind: 'page', name: 'shared' }, pageState)
        await writeReviewState(root, { kind: 'fragment', name: 'shared' }, fragState)
        expect(await readReviewState(root, { kind: 'page', name: 'shared' })).toEqual(pageState)
        expect(await readReviewState(root, { kind: 'fragment', name: 'shared' })).toEqual(fragState)
      } finally {
        await cleanup()
      }
    })

    it('round-trips state through a subfolder manifest name (encodeRefName collapsing)', async () => {
      // Names like `blog/[slug]` collapse through encodeRefName so the
      // sidecar tree stays flat at one item-level directory. Path-helper
      // tests pin the string shape; this exercises the actual round-trip
      // through write + read against real storage so a future
      // path-helper change can't break the end-to-end behavior silently.
      const { root, cleanup } = await tier.create()
      try {
        const item: ManifestKey = { kind: 'page', name: 'blog/[slug]' }
        const state: ReviewSidecar = { state: 'approved', approvedAt: '2026-06-07T11:30:00.000Z' }
        await writeReviewState(root, item, state)
        await recordApprover(root, item, 'alice')
        expect(await readReviewState(root, item)).toEqual(state)
        expect(await readApprovers(root, item)).toEqual(['alice'])
      } finally {
        await cleanup()
      }
    })
  })

  describe(`per-approver sidecars (${tier.name})`, () => {
    it('returns an empty list when no approver sidecar has been written', async () => {
      const { root, cleanup } = await tier.create()
      try {
        expect(await readApprovers(root, PAGE_HOME)).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it('records and reads back one approver', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await recordApprover(root, PAGE_HOME, 'alice')
        expect(await readApprovers(root, PAGE_HOME)).toEqual(['alice'])
      } finally {
        await cleanup()
      }
    })

    it('records multiple approvers; readApprovers returns all (order-agnostic)', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await recordApprover(root, PAGE_HOME, 'alice')
        await recordApprover(root, PAGE_HOME, 'bob')
        await recordApprover(root, PAGE_HOME, 'carol')
        const approvers = await readApprovers(root, PAGE_HOME)
        expect(approvers.sort()).toEqual(['alice', 'bob', 'carol'])
      } finally {
        await cleanup()
      }
    })

    it('is idempotent — recording the same actor twice still surfaces them once', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await recordApprover(root, PAGE_HOME, 'alice')
        await recordApprover(root, PAGE_HOME, 'alice')
        expect(await readApprovers(root, PAGE_HOME)).toEqual(['alice'])
      } finally {
        await cleanup()
      }
    })

    it('handles two parallel recordApprover calls to different actor paths without conflict', async () => {
      // This is the multi-instance correctness story: distinct actor ids
      // write to distinct paths, so two instances racing to record
      // approvals don't trample each other.
      const { root, cleanup } = await tier.create()
      try {
        await Promise.all([recordApprover(root, PAGE_HOME, 'alice'), recordApprover(root, PAGE_HOME, 'bob')])
        const approvers = await readApprovers(root, PAGE_HOME)
        expect(approvers.sort()).toEqual(['alice', 'bob'])
      } finally {
        await cleanup()
      }
    })

    // Each row is one actor-id shape that operators encounter — emails,
    // OIDC subs, Cloudflare Access identity_nonces — exercised end-to-end
    // through record + read. Data-driven because the assertion shape is
    // identical across rows; only the input changes.
    it.each([
      { label: 'email', ids: ['alice@example.com', 'bob+test@example.com'] },
      { label: 'OIDC sub with pipe', ids: ['auth0|abc123', 'google|117258694'] },
      { label: 'OIDC sub with slash', ids: ['oauth/google/xyz', 'oauth/github/123'] },
      { label: 'Cloudflare-Access-style hex', ids: ['a1b2c3d4e5f60718', 'fedcba9876543210'] },
    ])('round-trips $label actor ids through filesystem encoding', async ({ ids }) => {
      const { root, cleanup } = await tier.create()
      try {
        for (const id of ids) await recordApprover(root, PAGE_HOME, id)
        expect((await readApprovers(root, PAGE_HOME)).sort()).toEqual([...ids].sort())
      } finally {
        await cleanup()
      }
    })

    it('keeps approvers for different items isolated', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await recordApprover(root, PAGE_HOME, 'alice')
        await recordApprover(root, FRAGMENT_HEADER, 'bob')
        expect(await readApprovers(root, PAGE_HOME)).toEqual(['alice'])
        expect(await readApprovers(root, FRAGMENT_HEADER)).toEqual(['bob'])
      } finally {
        await cleanup()
      }
    })

    it('approver sidecars sit alongside state.json without colliding', async () => {
      // The state-file path is `…/state.json`; approver paths are
      // `…/approvers/{actor}`. They occupy distinct keys; both must be
      // independently readable.
      const { root, cleanup } = await tier.create()
      try {
        await writeReviewState(root, PAGE_HOME, {
          state: 'pending-review',
          submittedBy: 'alice',
          requiredApprovers: 2,
        })
        await recordApprover(root, PAGE_HOME, 'bob')
        await recordApprover(root, PAGE_HOME, 'carol')

        const state = await readReviewState(root, PAGE_HOME)
        const approvers = await readApprovers(root, PAGE_HOME)
        expect(state?.state).toBe('pending-review')
        expect(approvers.sort()).toEqual(['bob', 'carol'])
      } finally {
        await cleanup()
      }
    })
  })

  describe(`clearApprovers (${tier.name})`, () => {
    it('is a no-op when the approvers directory does not exist', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await clearApprovers(root, PAGE_HOME)
        expect(await readApprovers(root, PAGE_HOME)).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it('removes all recorded approvers, leaving the dir empty', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await recordApprover(root, PAGE_HOME, 'alice')
        await recordApprover(root, PAGE_HOME, 'bob')
        expect(await readApprovers(root, PAGE_HOME)).toHaveLength(2)

        await clearApprovers(root, PAGE_HOME)
        expect(await readApprovers(root, PAGE_HOME)).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it('does not touch state.json — clearApprovers is scoped to the approvers/ directory', async () => {
      const { root, cleanup } = await tier.create()
      try {
        const state: ReviewSidecar = {
          state: 'pending-review',
          submittedBy: 'alice',
          requiredApprovers: 1,
        }
        await writeReviewState(root, PAGE_HOME, state)
        await recordApprover(root, PAGE_HOME, 'bob')

        await clearApprovers(root, PAGE_HOME)
        expect(await readReviewState(root, PAGE_HOME)).toEqual(state)
        expect(await readApprovers(root, PAGE_HOME)).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it('only clears approvers for the targeted item, not siblings', async () => {
      const { root, cleanup } = await tier.create()
      try {
        await recordApprover(root, PAGE_HOME, 'alice')
        await recordApprover(root, FRAGMENT_HEADER, 'bob')

        await clearApprovers(root, PAGE_HOME)
        expect(await readApprovers(root, PAGE_HOME)).toEqual([])
        expect(await readApprovers(root, FRAGMENT_HEADER)).toEqual(['bob'])
      } finally {
        await cleanup()
      }
    })
  })
}
