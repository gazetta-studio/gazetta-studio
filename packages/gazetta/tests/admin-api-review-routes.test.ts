/**
 * Review workflow cut 7 (#521): the review routes, driven through
 * `createAdminApp` against memory storage. Every test builds a fresh
 * storage and app (rule 26).
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { AuditEvent } from '../src/audit/types.js'
import { readApprovers, readReviewSidecar, reviewPendingPath, type ReviewStateKind } from '../src/review/index.js'
import type { ReviewWorkflowConfig, SiteManifest } from '../src/types.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage } from './_helpers/memory-storage.js'

type Auth = NonNullable<SiteManifest['admin']>['auth']

interface SetupOpts {
  review?: ReviewWorkflowConfig
  auth?: Auth
}

function seeded() {
  const storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', content: { title: 'Home' } }),
    'pages/home/page.fr.json': JSON.stringify({ template: 'page-default', content: { title: 'Accueil' } }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }),
  })
  return storage
}

function setup(opts: SetupOpts = {}) {
  const local = seeded()
  const production = seeded()
  const review = opts.review ?? { enabled: true }
  const targetConfigs = {
    local: {
      storage: local,
      publicStorage: false,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
    },
    production: {
      storage: production,
      type: 'esi' as const,
      environment: 'production' as const,
      editable: false,
      publicStorage: false,
    },
  }
  const manifest: SiteManifest = {
    name: 'test-site',
    targets: targetConfigs,
    reviewWorkflow: review,
    admin: { ...(opts.auth ? { auth: opts.auth } : {}), audit: { provider: 'history' } },
  }
  const source = createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/test-project', manifest })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', local],
      ['production', production],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    validators: createValidatorRegistry([]),
  })
  const productionRoot = createSourceContext({ storage: production, siteDir: '', manifest }).contentRoot
  return { app, local, production, contentRoot: source.contentRoot, productionRoot }
}

type Harness = ReturnType<typeof setup>

const FORWARDED: Auth = {
  trust: 'forwarded-user',
  allowAnyOrigin: true,
  roleMapping: {
    claim: 'groups',
    map: { admins: 'admin', editors: 'editor', viewers: 'viewer' },
    defaultRole: 'viewer',
  },
}

function as(user: string, group: string): Record<string, string> {
  return { 'X-Forwarded-User': user, 'X-Forwarded-Email': user, 'X-Forwarded-Groups': group }
}

function post(
  h: Harness,
  kind: ReviewStateKind,
  name: string,
  action: string,
  opts: { body?: unknown; headers?: Record<string, string>; query?: string } = {},
): Promise<Response> {
  const body = opts.body ?? (action === 'reject' ? { comment: 'Needs work' } : undefined)
  return Promise.resolve(
    h.app.request(`/api/v1/review/${kind}/${name}/${action}${opts.query ?? ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const markerExists = (h: Harness, kind: ReviewStateKind, name: string) =>
  h.local.exists(reviewPendingPath(h.contentRoot, kind, name))

describe('review transitions', () => {
  it.each(['page', 'fragment'] as const)('submit then approve moves a %s to approved', async kind => {
    const h = setup()
    const name = kind === 'page' ? 'home' : 'header'
    const submitted = await post(h, kind, name, 'submit')
    expect(submitted.status).toBe(200)
    expect(await submitted.json()).toMatchObject({ kind, name, state: 'pending-review', requiredApprovers: 1 })

    const approved = await post(h, kind, name, 'approve')
    expect(approved.status).toBe(200)
    const body = (await approved.json()) as { state: string; approvers: string[] }
    expect(body.state).toBe('approved')
    expect(body.approvers).toHaveLength(1)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('approved')
  })

  it('submit on an item already pending answers 409 INVALID_TRANSITION', async () => {
    const h = setup()
    await post(h, 'page', 'home', 'submit')
    const res = await post(h, 'page', 'home', 'submit')
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_TRANSITION')
  })

  it.each([{ body: {} }, { body: { comment: '   ' } }])(
    'reject without a comment answers 400 COMMENT_REQUIRED (%o)',
    async ({ body }) => {
      const h = setup()
      await post(h, 'page', 'home', 'submit')
      const res = await post(h, 'page', 'home', 'reject', { body })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe('COMMENT_REQUIRED')
      expect((await readReviewSidecar(h.contentRoot, 'page', 'home'))?.state).toBe('pending-review')
    },
  )

  it('reject and withdraw send the item back to draft', async () => {
    const h = setup()
    await post(h, 'page', 'home', 'submit')
    const rejected = await post(h, 'page', 'home', 'reject')
    expect(((await rejected.json()) as { state: string }).state).toBe('draft')
    await post(h, 'page', 'home', 'submit')
    const withdrawn = await post(h, 'page', 'home', 'withdraw')
    expect(((await withdrawn.json()) as { state: string }).state).toBe('draft')
    expect(await readReviewSidecar(h.contentRoot, 'page', 'home')).toBeNull()
  })

  it('submit with review turned off answers 409 REVIEW_DISABLED', async () => {
    const h = setup({ review: { enabled: false } })
    const res = await post(h, 'page', 'home', 'submit')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('REVIEW_DISABLED')
  })

  it('a second approval is needed when requiredApprovers is 2', async () => {
    const h = setup({ review: { enabled: true, requiredApprovers: 2 }, auth: FORWARDED })
    await post(h, 'page', 'home', 'submit', { headers: as('alice@example.com', 'admins') })
    const first = await post(h, 'page', 'home', 'approve', { headers: as('bob@example.com', 'admins') })
    expect(((await first.json()) as { state: string }).state).toBe('pending-review')
    expect(await markerExists(h, 'page', 'home')).toBe(true)
    const again = await post(h, 'page', 'home', 'approve', { headers: as('bob@example.com', 'admins') })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe('ALREADY_VOTED')
    const second = await post(h, 'page', 'home', 'approve', { headers: as('carol@example.com', 'admins') })
    expect(((await second.json()) as { state: string }).state).toBe('approved')
    expect((await readApprovers(h.contentRoot, 'page', 'home')).sort()).toHaveLength(2)
    expect(await markerExists(h, 'page', 'home')).toBe(false)
  })

  it('two approvals at the same moment still reach the threshold', async () => {
    const h = setup({ review: { enabled: true, requiredApprovers: 2 }, auth: FORWARDED })
    await post(h, 'page', 'home', 'submit', { headers: as('alice@example.com', 'admins') })
    const [a, b] = await Promise.all([
      post(h, 'page', 'home', 'approve', { headers: as('bob@example.com', 'admins') }),
      post(h, 'page', 'home', 'approve', { headers: as('carol@example.com', 'admins') }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await readReviewSidecar(h.contentRoot, 'page', 'home'))?.state).toBe('approved')
    expect(await markerExists(h, 'page', 'home')).toBe(false)
  })

  it('an approval that lands after a reject leaves the item in draft with no vote', async () => {
    const h = setup()
    await post(h, 'page', 'home', 'submit')
    // The reject lands between the approval's read and its vote.
    const write = h.local.writeFile.bind(h.local)
    let rejected = false
    h.local.writeFile = async (path, content, opts) => {
      if (!rejected && path.includes('/approvers/')) {
        rejected = true
        expect((await post(h, 'page', 'home', 'reject')).status).toBe(200)
      }
      return write(path, content, opts)
    }
    expect((await post(h, 'page', 'home', 'approve')).status).toBe(200)
    expect(rejected).toBe(true)
    expect(await readReviewSidecar(h.contentRoot, 'page', 'home')).toBeNull()
    expect(await readApprovers(h.contentRoot, 'page', 'home')).toEqual([])
    expect(await markerExists(h, 'page', 'home')).toBe(false)
  })

  it('an archived item answers 409 ARCHIVED and takes no review', async () => {
    const h = setup()
    expect((await h.app.request('/api/v1/pages/home/archive', { method: 'POST' })).status).toBe(200)
    const res = await post(h, 'page', 'home', 'submit')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('ARCHIVED')
    expect(await readReviewSidecar(h.contentRoot, 'page', 'home')).toBeNull()
    expect(await markerExists(h, 'page', 'home')).toBe(false)
  })

  it('a missing item answers 404', async () => {
    const h = setup()
    const res = await post(h, 'page', 'nope', 'submit')
    expect(res.status).toBe(404)
  })
})

describe('capability gates', () => {
  it.each([
    { action: 'submit', group: 'viewers', missing: 'review:submit' },
    { action: 'withdraw', group: 'viewers', missing: 'review:submit' },
    { action: 'approve', group: 'editors', missing: 'review:approve' },
    { action: 'reject', group: 'editors', missing: 'review:approve' },
  ])('$action without $missing answers 403', async ({ action, group, missing }) => {
    const h = setup({ auth: FORWARDED })
    const res = await post(h, 'page', 'home', action, { headers: as('dana@example.com', group) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[] }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual([missing])
  })

  it('a missing capability answers 403 even for an item that does not exist', async () => {
    const h = setup({ auth: FORWARDED })
    const res = await post(h, 'page', 'nope', 'submit', { headers: as('dana@example.com', 'viewers') })
    expect(res.status).toBe(403)
  })

  it('withdraw by someone other than the submitter answers 403 NOT_SUBMITTER', async () => {
    const h = setup({ auth: FORWARDED })
    await post(h, 'page', 'home', 'submit', { headers: as('alice@example.com', 'editors') })
    const res = await post(h, 'page', 'home', 'withdraw', { headers: as('erin@example.com', 'editors') })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('NOT_SUBMITTER')
  })

  it('GET without read access answers 403', async () => {
    const h = setup({
      auth: {
        ...FORWARDED,
        roles: { nobody: { capabilities: ['review:submit'] } },
        roleMapping: { ...FORWARDED.roleMapping!, defaultRole: 'nobody' },
      },
    } as SetupOpts)
    const res = await h.app.request('/api/v1/review/page/home', { headers: as('zed@example.com', 'none') })
    expect(res.status).toBe(403)
  })
})

describe('pending marker', () => {
  it('submit writes it', async () => {
    const h = setup()
    await post(h, 'page', 'home', 'submit')
    expect(await h.local.exists('.gazetta/review/pending/page/home')).toBe(true)
  })

  it.each(['approve', 'reject', 'withdraw'])('%s removes it', async action => {
    const h = setup()
    await post(h, 'page', 'home', 'submit')
    const res = await post(h, 'page', 'home', action)
    expect(res.status).toBe(200)
    expect(await h.local.exists('.gazetta/review/pending/page/home')).toBe(false)
  })
})

describe('read-only target', () => {
  it('a submit to it answers 403 TARGET_NOT_EDITABLE and writes nothing there', async () => {
    const h = setup()
    const res = await post(h, 'page', 'home', 'submit', { query: '?target=production' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe('TARGET_NOT_EDITABLE')
    expect(await readReviewSidecar(h.productionRoot, 'page', 'home')).toBeNull()
    expect(await h.production.exists('.gazetta/review/pending/page/home')).toBe(false)
    expect(await h.production.exists('.gazetta/review')).toBe(false)
  })
})

describe('GET /api/v1/review/{kind}/:name', () => {
  it('returns draft and no history for an item never submitted', async () => {
    const h = setup()
    const res = await h.app.request('/api/v1/review/page/home')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: 'page', name: 'home', state: 'draft', approvers: [], history: [] })
  })

  it('lists the review events newest first, same-millisecond events included', async () => {
    const h = setup()
    for (const action of ['submit', 'reject', 'submit', 'withdraw']) {
      expect((await post(h, 'page', 'home', action)).status).toBe(200)
    }
    const res = await h.app.request('/api/v1/review/page/home')
    const body = (await res.json()) as { state: string; history: AuditEvent[] }
    expect(body.state).toBe('draft')
    expect(body.history.map(e => e.action)).toEqual([
      'review-withdraw',
      'review-submit',
      'review-reject',
      'review-submit',
    ])
    expect(body.history[2]?.metadata).toMatchObject({ comment: 'Needs work' })
  })

  it("keeps only this item's review events", async () => {
    const h = setup()
    await post(h, 'page', 'home', 'submit')
    await post(h, 'fragment', 'header', 'submit')
    await post(h, 'page', 'home', 'reject', { body: {} })
    const body = (await (await h.app.request('/api/v1/review/page/home')).json()) as { history: AuditEvent[] }
    expect(body.history.map(e => [e.action, e.outcome, e.scope.name])).toEqual([
      ['review-reject', 'validation-failed', 'home'],
      ['review-submit', 'success', 'home'],
    ])
  })

  it('shows the pending state with its approvers', async () => {
    const h = setup({ review: { enabled: true, requiredApprovers: 2 } })
    await post(h, 'page', 'home', 'submit')
    await post(h, 'page', 'home', 'approve')
    const body = (await (await h.app.request('/api/v1/review/page/home')).json()) as Record<string, unknown>
    expect(body).toMatchObject({ state: 'pending-review', requiredApprovers: 2 })
    expect(body.approvers).toHaveLength(1)
  })
})
