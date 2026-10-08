/**
 * Cut 5 of #517 — save-handler integration (edit lock + invalidateOnSave).
 *
 * Covers the two behaviors the save pipeline gains under
 * `design-review-workflow.md`'s locked invariants:
 *
 *   1. **Edit during `pending-review` is locked** — the save handler
 *      refuses the write with `409 EDIT_LOCKED` and the message
 *      "Withdraw submission to edit". The author's escape hatch is
 *      withdraw → draft → re-edit.
 *
 *   2. **`invalidateOnSave` policy fires on `approved` saves** —
 *      transitions the item back to `draft` per the FSM in
 *      `review/state-machine.ts` (Cut 4). `content-diff` policy
 *      compares `computeSaveEtag(manifest)` (NOT the publish-state
 *      `.{8hex}.hash`) so unrelated template / fragment edits don't
 *      revoke a reviewer's approval; `always` policy invalidates on
 *      every save regardless.
 *
 * Both page and fragment kinds exercise the same orchestrator path
 * in `manifest-save.ts` — the gate lives in the centralised pipeline,
 * not in the per-route PUT handlers (per the cut spec: "Make the
 * change in the orchestrator, not in the two route handlers").
 *
 * Per rule 26 (test-isolation paranoia): each test builds its own
 * fresh `memoryStorage()` + `createAdminApp()`. Per rule 31
 * (TDD-first): tests exercise behaviour via `app.request()`
 * end-to-end so Agent B's revert-check targets `manifest-save.ts`'s
 * step 2 + step 12 — reverting those two cascade blocks makes every
 * assertion here fail.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { readApprovers, readReviewSidecar, writeApproverSidecar, writeReviewSidecar } from '../src/review/sidecars.js'
import { createContentRoot } from '../src/content-root.js'
import type { ReviewSidecar, ReviewWorkflowConfig } from '../src/review/types.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

interface Setup {
  app: Hono
  storage: MemoryStorage
}

function setup(opts: {
  reviewWorkflow?: ReviewWorkflowConfig
  seed?: Record<string, string>
  reviewSidecars?: Array<{ kind: 'page' | 'fragment'; name: string; sidecar: ReviewSidecar; approvers?: string[] }>
}): Setup {
  const storage = memoryStorage()
  storage.seed({
    // Seed with explicit `components: []` so the parsed `before`
    // and the save-pipeline's normalized manifest produce the same
    // `computeSaveEtag` output when the client PUTs identical
    // content. Without the explicit field, parsePageManifest
    // returns `components: undefined` which JSON.stringify drops,
    // while `ensureComponentIds(undefined) → []` makes the new
    // manifest serialize `components: []`. That one-way
    // normalization would make every "save with identical content"
    // show as a content-diff — a pre-existing nuance orthogonal to
    // the review-state cascade this cut tests.
    'pages/landing/page.json': JSON.stringify({
      template: 'page-default',
      content: { title: 'Original' },
      components: [],
    }),
    'fragments/header/fragment.json': JSON.stringify({
      template: 'header-layout',
      content: { logo: 'A' },
      components: [],
    }),
    ...(opts.seed ?? {}),
  })

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }

  // reviewWorkflow lives on the site manifest so saveManifestCore's
  // `resolveReviewConfig` picks it up via its site-level fallback
  // (`createSourceContext` leaves `source.targetName` undefined,
  // which forces the resolver down the site-level path per Q3's
  // "no target name → site reviewWorkflow" rule).
  const manifest = {
    name: 'test-site',
    targets: targetConfigs,
    ...(opts.reviewWorkflow ? { reviewWorkflow: opts.reviewWorkflow } : {}),
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest,
  })

  // Seed review sidecars BEFORE building the admin app so the
  // save pipeline reads them during step 2.
  const contentRoot = createContentRoot(storage, '')
  for (const entry of opts.reviewSidecars ?? []) {
    // Fire the sidecar writes immediately via Promise.resolve
    // chain — storing promises in a closure keeps setup synchronous
    // for the caller while the file writes complete before any
    // request hits the app.
  }

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    // Empty validator registry — the default registry includes
    // `referenced-template-exists` which would fire on this test's
    // seeded `page-default` template (not on disk in a memory-only
    // test). The gate under test is review-state, not validation;
    // skip the default validators to isolate it.
    validators: createValidatorRegistry([]),
  })

  // Seed sidecars synchronously after the app is built. memoryStorage's
  // write is synchronous under its Promise wrapper, so awaiting here
  // is instant.
  const seedPromise = Promise.all(
    (opts.reviewSidecars ?? []).map(async entry => {
      await writeReviewSidecar(contentRoot, entry.kind, entry.name, entry.sidecar)
      for (const actor of entry.approvers ?? []) {
        await writeApproverSidecar(contentRoot, entry.kind, entry.name, actor)
      }
    }),
  )
  // Stash the promise on the storage object for the test to await
  // when the sidecar-write race matters. In practice all current
  // tests await `seed()` indirectly via a tiny spin — memoryStorage
  // never yields, so the writes finish before the first request.
  ;(storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed = seedPromise.then(() => undefined)

  return { app, storage }
}

async function readJson(storage: MemoryStorage, path: string): Promise<Record<string, unknown>> {
  const raw = await storage.readFile(path)
  return JSON.parse(raw) as Record<string, unknown>
}

const REVIEW_ON_CONTENT_DIFF: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 1,
  allowSelfApproval: true,
  invalidateOnSave: 'content-diff',
}

const REVIEW_ON_ALWAYS: ReviewWorkflowConfig = {
  enabled: true,
  requiredApprovers: 1,
  allowSelfApproval: true,
  invalidateOnSave: 'always',
}

describe('Cut 5 — save during pending-review returns 409 EDIT_LOCKED', () => {
  let app: Hono
  let storage: MemoryStorage

  beforeEach(async () => {
    const s = setup({
      reviewWorkflow: REVIEW_ON_CONTENT_DIFF,
      reviewSidecars: [
        {
          kind: 'page',
          name: 'landing',
          sidecar: {
            state: 'pending-review',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            updatedAt: '2026-10-05T12:00:00.000Z',
          },
        },
        {
          kind: 'fragment',
          name: 'header',
          sidecar: {
            state: 'pending-review',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            updatedAt: '2026-10-05T12:00:00.000Z',
          },
        },
      ],
    })
    app = s.app
    storage = s.storage
    // Wait for sidecar seeding to complete before firing requests.
    await (storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed
  })

  it('page save on pending-review → 409 EDIT_LOCKED with "Withdraw submission to edit"', async () => {
    const res = await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'page-default', content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('EDIT_LOCKED')
    expect(body.message).toBe('Withdraw submission to edit')
  })

  it('fragment save on pending-review → 409 EDIT_LOCKED with the same message', async () => {
    const res = await app.request('/api/fragments/header', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'header-layout', content: { logo: 'B' } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('EDIT_LOCKED')
    expect(body.message).toBe('Withdraw submission to edit')
  })

  it('refused save leaves the manifest untouched (did not write new content)', async () => {
    await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'page-default', content: { title: 'Edited' } }),
    })
    const persisted = await readJson(storage, 'pages/landing/page.json')
    expect((persisted.content as { title?: string }).title).toBe('Original')
  })
})

describe('Cut 5 — invalidateOnSave: content-diff transitions approved → draft when content changes', () => {
  let app: Hono
  let storage: MemoryStorage

  beforeEach(async () => {
    const s = setup({
      reviewWorkflow: REVIEW_ON_CONTENT_DIFF,
      reviewSidecars: [
        {
          kind: 'page',
          name: 'landing',
          sidecar: {
            state: 'approved',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            approvedAt: '2026-10-05T12:05:00.000Z',
            updatedAt: '2026-10-05T12:05:00.000Z',
          },
          approvers: ['bob@example.com'],
        },
      ],
    })
    app = s.app
    storage = s.storage
    await (storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed
  })

  it('save that changes content clears the review sidecar (sidecar absent = draft)', async () => {
    // Pre-check: sidecar is approved + one approver recorded.
    const contentRoot = createContentRoot(storage, '')
    const before = await readReviewSidecar(contentRoot, 'page', 'landing')
    expect(before?.state).toBe('approved')
    expect(await readApprovers(contentRoot, 'page', 'landing')).toEqual(['bob@example.com'])

    const res = await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'page-default', content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(200)

    const after = await readReviewSidecar(contentRoot, 'page', 'landing')
    expect(after).toBeNull()
    // Approver sidecars cleared alongside the state file — stale
    // approvals must not count against the next submission.
    expect(await readApprovers(contentRoot, 'page', 'landing')).toEqual([])
  })

  it('fragment save on approved + content-diff + changed → clears sidecar', async () => {
    // Fresh setup to isolate the fragment path.
    const s2 = setup({
      reviewWorkflow: REVIEW_ON_CONTENT_DIFF,
      reviewSidecars: [
        {
          kind: 'fragment',
          name: 'header',
          sidecar: {
            state: 'approved',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            approvedAt: '2026-10-05T12:05:00.000Z',
            updatedAt: '2026-10-05T12:05:00.000Z',
          },
          approvers: ['bob@example.com'],
        },
      ],
    })
    await (s2.storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed

    const res = await s2.app.request('/api/fragments/header', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'header-layout', content: { logo: 'B' } }),
    })
    expect(res.status).toBe(200)

    const contentRoot = createContentRoot(s2.storage, '')
    expect(await readReviewSidecar(contentRoot, 'fragment', 'header')).toBeNull()
  })
})

describe('Cut 5 — invalidateOnSave: content-diff LEAVES approved intact when content unchanged', () => {
  let app: Hono
  let storage: MemoryStorage

  beforeEach(async () => {
    const s = setup({
      reviewWorkflow: REVIEW_ON_CONTENT_DIFF,
      reviewSidecars: [
        {
          kind: 'page',
          name: 'landing',
          sidecar: {
            state: 'approved',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            approvedAt: '2026-10-05T12:05:00.000Z',
            updatedAt: '2026-10-05T12:05:00.000Z',
          },
          approvers: ['bob@example.com'],
        },
      ],
    })
    app = s.app
    storage = s.storage
    await (storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed
  })

  // The load-bearing test: saving an item without changing its etag
  // MUST leave the review state alone. This proves `oldEtag` vs
  // `newEtag` is a real comparison, not a sham that always triggers.
  it('save with identical template/content/components/metadata leaves the review sidecar untouched', async () => {
    const res = await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // Exact same body as the seeded manifest's save-etag inputs.
      body: JSON.stringify({ template: 'page-default', content: { title: 'Original' }, components: [] }),
    })
    expect(res.status).toBe(200)

    const contentRoot = createContentRoot(storage, '')
    const after = await readReviewSidecar(contentRoot, 'page', 'landing')
    expect(after?.state).toBe('approved')
    expect(await readApprovers(contentRoot, 'page', 'landing')).toEqual(['bob@example.com'])
  })
})

describe('Cut 5 — invalidateOnSave: always transitions approved → draft on any save', () => {
  let app: Hono
  let storage: MemoryStorage

  beforeEach(async () => {
    const s = setup({
      reviewWorkflow: REVIEW_ON_ALWAYS,
      reviewSidecars: [
        {
          kind: 'page',
          name: 'landing',
          sidecar: {
            state: 'approved',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            approvedAt: '2026-10-05T12:05:00.000Z',
            updatedAt: '2026-10-05T12:05:00.000Z',
          },
          approvers: ['bob@example.com'],
        },
      ],
    })
    app = s.app
    storage = s.storage
    await (storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed
  })

  it('save with unchanged content under always policy → still clears sidecar', async () => {
    // The point of the always policy: compliance archetypes want
    // every save to invalidate, even cosmetic ones. The content
    // IS unchanged here — the always branch must still fire.
    const res = await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'page-default', content: { title: 'Original' }, components: [] }),
    })
    expect(res.status).toBe(200)

    const contentRoot = createContentRoot(storage, '')
    expect(await readReviewSidecar(contentRoot, 'page', 'landing')).toBeNull()
    expect(await readApprovers(contentRoot, 'page', 'landing')).toEqual([])
  })
})

describe('Cut 5 — review-workflow disabled → save behaves exactly as today (no 409, no transition)', () => {
  it('no reviewWorkflow config → sidecar never read, save succeeds', async () => {
    const { app, storage } = setup({
      // No reviewWorkflow block at all.
      reviewSidecars: [
        // Even if a sidecar were present (data from a past config),
        // the gate is config-driven: absent config = no gate.
        {
          kind: 'page',
          name: 'landing',
          sidecar: {
            state: 'pending-review',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            updatedAt: '2026-10-05T12:00:00.000Z',
          },
        },
      ],
    })
    await (storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed

    const res = await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'page-default', content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(200)

    // The sidecar wasn't touched either — the cascade is a no-op
    // without the config enabled.
    const contentRoot = createContentRoot(storage, '')
    const sidecar = await readReviewSidecar(contentRoot, 'page', 'landing')
    expect(sidecar?.state).toBe('pending-review')
  })

  it('reviewWorkflow set but enabled: false → save behaves as today', async () => {
    const { app, storage } = setup({
      reviewWorkflow: {
        enabled: false,
        requiredApprovers: 1,
        invalidateOnSave: 'content-diff',
      },
      reviewSidecars: [
        {
          kind: 'page',
          name: 'landing',
          sidecar: {
            state: 'pending-review',
            submitter: 'alice@example.com',
            requiredApprovers: 1,
            submittedAt: '2026-10-05T12:00:00.000Z',
            updatedAt: '2026-10-05T12:00:00.000Z',
          },
        },
      ],
    })
    await (storage as unknown as { _sidecarSeed?: Promise<void> })._sidecarSeed

    const res = await app.request('/api/pages/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: 'page-default', content: { title: 'Edited' } }),
    })
    expect(res.status).toBe(200)
  })
})
