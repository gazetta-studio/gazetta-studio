/**
 * Unit tests for the per-edge review sidecar storage primitives
 * (Cut 3 of #517). Exercises behavior over both memory + filesystem
 * storage tiers so the FS-specific concerns (readDir on missing
 * directory, rm-recursive, encode-safe filenames across platforms)
 * are covered alongside the shape invariants.
 *
 * What this file pins:
 *   - state.json round-trip through writeReviewSidecar /
 *     readReviewSidecar
 *   - repeated writes are idempotent (last-write-wins; no
 *     accumulation of stale state)
 *   - approver sidecars are independent zero-byte files; two
 *     actors voting touch distinct paths
 *   - concurrent writes from different "instances" to different
 *     approver paths converge without conflict (the multi-instance
 *     correctness story)
 *   - actor IDs with non-filename characters (@, |) encode safely
 *     and round-trip through the directory listing
 *   - name encoding passes through `encodeRefName`, so nested
 *     names like `blog/[slug]` get collision-free storage paths
 *   - clearReviewSidecar + removeApproverSidecar are idempotent
 *     (no error on missing paths)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import {
  clearReviewSidecar,
  readApprovers,
  readReviewSidecar,
  removeApproverSidecar,
  reviewApproverPath,
  reviewApproversDir,
  reviewStatePath,
  writeApproverSidecar,
  writeReviewSidecar,
} from '../src/review/sidecars.js'
import type { ReviewSidecar } from '../src/review/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const fsRoot = tempDir(`review-sidecars-${Date.now()}`)

afterEach(async () => {
  await rm(fsRoot, { recursive: true, force: true })
})

const SAMPLE_SIDECAR: ReviewSidecar = {
  state: 'pending-review',
  submitter: 'alice@example.com',
  requiredApprovers: 2,
  submittedAt: '2026-10-05T12:00:00.000Z',
  updatedAt: '2026-10-05T12:00:00.000Z',
}

/**
 * Two storage tiers. Memory keeps setup ~10ms per test and covers
 * the shape invariants; filesystem covers readDir-on-missing-dir
 * semantics + nested-dir creation + cross-platform safe filenames.
 * Both tiers run every behavior test — the per-edge pattern must
 * hold identically on both.
 */
const TIERS = [
  {
    name: 'memory',
    build: () => createContentRoot(memoryStorage(), ''),
    prep: async () => {
      /* memory needs no setup */
    },
  },
  {
    name: 'filesystem',
    build: () => createContentRoot(createFilesystemProvider(fsRoot), ''),
    prep: async () => {
      await mkdir(fsRoot, { recursive: true })
    },
  },
] as const

for (const tier of TIERS) {
  describe(`review sidecars — ${tier.name} storage`, () => {
    describe('writeReviewSidecar + readReviewSidecar — round-trip', () => {
      it('writes state.json and reads it back verbatim', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        const read = await readReviewSidecar(root, 'page', 'home')
        expect(read).toEqual(SAMPLE_SIDECAR)
      })

      it('writes to the design-doc path shape (.gazetta/review/{kind}/{name}/state.json)', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'fragment', 'header', SAMPLE_SIDECAR)
        const expected = reviewStatePath(root, 'fragment', 'header')
        expect(expected).toContain('.gazetta/review/fragment/header/state.json')
        expect(await root.storage.exists(expected)).toBe(true)
      })

      it('returns null when the state file does not exist', async () => {
        await tier.prep()
        const root = tier.build()
        expect(await readReviewSidecar(root, 'page', 'never-reviewed')).toBeNull()
      })

      it('encodes nested item names via encodeRefName (collision-free paths)', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'page', 'blog/[slug]', SAMPLE_SIDECAR)
        const path = reviewStatePath(root, 'page', 'blog/[slug]')
        expect(path).toContain('.gazetta/review/page/blog.[slug]/state.json')
        expect(await readReviewSidecar(root, 'page', 'blog/[slug]')).toEqual(SAMPLE_SIDECAR)
      })

      it('partitions page and fragment by kind — same name does not collide', async () => {
        await tier.prep()
        const root = tier.build()
        const pageSidecar: ReviewSidecar = { ...SAMPLE_SIDECAR, submitter: 'alice@example.com' }
        const fragmentSidecar: ReviewSidecar = { ...SAMPLE_SIDECAR, submitter: 'bob@example.com' }
        await writeReviewSidecar(root, 'page', 'thing', pageSidecar)
        await writeReviewSidecar(root, 'fragment', 'thing', fragmentSidecar)
        expect(await readReviewSidecar(root, 'page', 'thing')).toEqual(pageSidecar)
        expect(await readReviewSidecar(root, 'fragment', 'thing')).toEqual(fragmentSidecar)
      })
    })

    describe('writeReviewSidecar — idempotency', () => {
      it('repeated writes with the same payload leave the final state unchanged', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        expect(await readReviewSidecar(root, 'page', 'home')).toEqual(SAMPLE_SIDECAR)
      })

      it('last-write-wins when payloads differ (approved overwrites pending)', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        const approved: ReviewSidecar = {
          state: 'approved',
          submitter: 'alice@example.com',
          requiredApprovers: 2,
          submittedAt: SAMPLE_SIDECAR.submittedAt,
          approvedAt: '2026-10-05T13:00:00.000Z',
          updatedAt: '2026-10-05T13:00:00.000Z',
        }
        await writeReviewSidecar(root, 'page', 'home', approved)
        expect(await readReviewSidecar(root, 'page', 'home')).toEqual(approved)
      })
    })

    describe('writeApproverSidecar + readApprovers', () => {
      it('writes a zero-byte sidecar whose filename encodes the actor ID', async () => {
        await tier.prep()
        const root = tier.build()
        await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        const path = reviewApproverPath(root, 'page', 'home', 'alice@example.com')
        expect(path).toContain('.gazetta/review/page/home/approvers/alice%40example.com')
        const bytes = await root.storage.readFile(path)
        expect(bytes).toBe('')
      })

      it('readApprovers returns [] for an item with no votes', async () => {
        await tier.prep()
        const root = tier.build()
        expect(await readApprovers(root, 'page', 'home')).toEqual([])
      })

      it('two actors voting write to distinct paths and both surface in readApprovers', async () => {
        await tier.prep()
        const root = tier.build()
        await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        await writeApproverSidecar(root, 'page', 'home', 'bob@example.com')
        const actors = await readApprovers(root, 'page', 'home')
        expect(actors).toHaveLength(2)
        expect(actors).toContain('alice@example.com')
        expect(actors).toContain('bob@example.com')
      })

      it('duplicate votes from the same actor are idempotent — one sidecar remains', async () => {
        await tier.prep()
        const root = tier.build()
        await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        const actors = await readApprovers(root, 'page', 'home')
        expect(actors).toEqual(['alice@example.com'])
      })

      it('actor IDs with non-filename chars round-trip (OIDC provider|id subjects)', async () => {
        await tier.prep()
        const root = tier.build()
        const oidc = 'cloudflare|identity-nonce-abc'
        const uuid = 'auth0|507f1f77bcf86cd799439011'
        await writeApproverSidecar(root, 'page', 'home', oidc)
        await writeApproverSidecar(root, 'page', 'home', uuid)
        const actors = await readApprovers(root, 'page', 'home')
        expect(actors).toContain(oidc)
        expect(actors).toContain(uuid)
      })

      it('two "instances" writing different approvers concurrently converge without conflict', async () => {
        // The multi-instance correctness story: Promise.all simulates
        // two admin processes writing their own approver sidecars at
        // the same wall-clock moment. Granularity (different paths)
        // means no race — both writes land, both actors appear.
        await tier.prep()
        const root = tier.build()
        await Promise.all([
          writeApproverSidecar(root, 'page', 'home', 'alice@example.com'),
          writeApproverSidecar(root, 'page', 'home', 'bob@example.com'),
          writeApproverSidecar(root, 'page', 'home', 'carol@example.com'),
        ])
        const actors = await readApprovers(root, 'page', 'home')
        expect(actors).toHaveLength(3)
        expect(actors).toContain('alice@example.com')
        expect(actors).toContain('bob@example.com')
        expect(actors).toContain('carol@example.com')
      })

      it('page and fragment approver sets with the same name do not share state', async () => {
        await tier.prep()
        const root = tier.build()
        await writeApproverSidecar(root, 'page', 'thing', 'alice@example.com')
        await writeApproverSidecar(root, 'fragment', 'thing', 'bob@example.com')
        expect(await readApprovers(root, 'page', 'thing')).toEqual(['alice@example.com'])
        expect(await readApprovers(root, 'fragment', 'thing')).toEqual(['bob@example.com'])
      })
    })

    describe('removeApproverSidecar', () => {
      it('removes one actor without affecting peers', async () => {
        await tier.prep()
        const root = tier.build()
        await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        await writeApproverSidecar(root, 'page', 'home', 'bob@example.com')
        await removeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        const actors = await readApprovers(root, 'page', 'home')
        expect(actors).toEqual(['bob@example.com'])
      })

      it('is idempotent when the actor never voted', async () => {
        await tier.prep()
        const root = tier.build()
        await expect(removeApproverSidecar(root, 'page', 'home', 'nobody@example.com')).resolves.toBeUndefined()
      })
    })

    describe('clearReviewSidecar', () => {
      it('removes state.json and all approver sidecars for one item', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
        await writeApproverSidecar(root, 'page', 'home', 'bob@example.com')
        await clearReviewSidecar(root, 'page', 'home')
        expect(await readReviewSidecar(root, 'page', 'home')).toBeNull()
        expect(await readApprovers(root, 'page', 'home')).toEqual([])
      })

      it('is idempotent when the item has no review activity', async () => {
        await tier.prep()
        const root = tier.build()
        await expect(clearReviewSidecar(root, 'page', 'never-reviewed')).resolves.toBeUndefined()
      })

      it('does not touch sibling items', async () => {
        await tier.prep()
        const root = tier.build()
        await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
        await writeReviewSidecar(root, 'page', 'about', SAMPLE_SIDECAR)
        await writeApproverSidecar(root, 'page', 'about', 'alice@example.com')
        await clearReviewSidecar(root, 'page', 'home')
        expect(await readReviewSidecar(root, 'page', 'about')).toEqual(SAMPLE_SIDECAR)
        expect(await readApprovers(root, 'page', 'about')).toEqual(['alice@example.com'])
      })
    })

    describe('path helpers — expose the layout for callers', () => {
      it('reviewApproversDir points at the approvers subdirectory', async () => {
        const root = tier.build()
        const dir = reviewApproversDir(root, 'page', 'home')
        expect(dir).toContain('.gazetta/review/page/home/approvers')
        expect(dir).not.toContain('state.json')
      })
    })
  })
}

// Filesystem-only check: directories actually get laid out on disk
// in the design-doc shape. Memory storage emulates directories as
// prefixes, so this test wouldn't tell us anything useful there.
describe('review sidecars — filesystem layout', () => {
  it('creates the per-item directory tree as separate directories', async () => {
    await mkdir(fsRoot, { recursive: true })
    const root = createContentRoot(createFilesystemProvider(fsRoot), '')
    await writeReviewSidecar(root, 'page', 'home', SAMPLE_SIDECAR)
    await writeApproverSidecar(root, 'page', 'home', 'alice@example.com')
    expect(existsSync(`${fsRoot}/.gazetta/review/page/home/state.json`)).toBe(true)
    expect(existsSync(`${fsRoot}/.gazetta/review/page/home/approvers/alice%40example.com`)).toBe(true)
  })
})
