/**
 * Contract tests — assert that the client's request/response types agree
 * with the server's Zod schemas at runtime.
 *
 * TypeScript already catches compile-time drift (the client's types come
 * from the same schema file via z.infer). This file catches value-level
 * drift: if a test fixture or a real request ever passes through with
 * a field TypeScript happens to allow (e.g. via `as any` or through an
 * un-typed intermediate), safeParse surfaces it here.
 *
 * Coverage is deliberately narrow — only the endpoints that have been
 * migrated to schema-validated contracts. Follow-ups extend the coverage
 * as each endpoint moves to the new pattern (testing-plan.md Priority 3.2).
 */
import { describe, it, expect } from 'vitest'
import {
  CreatePageRequestSchema,
  CreatePageResponseSchema,
  PageSummarySchema,
  PageMetadataSchema,
  CreateFragmentRequestSchema,
  CreateFragmentResponseSchema,
  FragmentSummarySchema,
  TemplateSummarySchema,
  FieldSummarySchema,
  TargetInfoSchema,
  TargetEnvironmentSchema,
  TargetTypeSchema,
  SiteManifestSchema,
  DependentsResponseSchema,
  CompareResultSchema,
  PublishResultSchema,
  PublishProgressSchema,
  RevisionSummarySchema,
  ListHistoryResponseSchema,
  RestoreRevisionResponseSchema,
  FetchResponseSchema,
} from 'gazetta/admin-api/schemas'
import type {
  CreatePageRequest,
  CreatePageResponse,
  PageSummary,
  PageMetadata,
  CreateFragmentRequest,
  CreateFragmentResponse,
  FragmentSummary,
  TemplateSummary,
  FieldSummary,
  TargetInfo,
  SiteManifest,
  DependentsResponse,
  CompareResult,
  PublishResult,
  PublishProgress,
  RevisionSummary,
  ListHistoryResponse,
  RestoreRevisionResponse,
  FetchResponse,
} from 'gazetta/admin-api/schemas'

describe('POST /api/pages contract', () => {
  describe('CreatePageRequest', () => {
    it('accepts the minimal shape the client uses', () => {
      const body: CreatePageRequest = { name: 'home', template: 'page-default' }
      expect(CreatePageRequestSchema.safeParse(body).success).toBe(true)
    })

    it('accepts an optional content field', () => {
      const body: CreatePageRequest = {
        name: 'home',
        template: 'page-default',
        content: { title: 'Home' },
      }
      expect(CreatePageRequestSchema.safeParse(body).success).toBe(true)
    })

    it('rejects empty name', () => {
      const r = CreatePageRequestSchema.safeParse({ name: '', template: 'page-default' })
      expect(r.success).toBe(false)
    })

    it('rejects empty template', () => {
      const r = CreatePageRequestSchema.safeParse({ name: 'home', template: '' })
      expect(r.success).toBe(false)
    })

    it('rejects missing required fields', () => {
      expect(CreatePageRequestSchema.safeParse({ name: 'home' }).success).toBe(false)
      expect(CreatePageRequestSchema.safeParse({ template: 'page-default' }).success).toBe(false)
      expect(CreatePageRequestSchema.safeParse({}).success).toBe(false)
    })
  })

  describe('CreatePageResponse', () => {
    it('accepts the response shape the server emits', () => {
      const resp: CreatePageResponse = { ok: true, name: 'home' }
      expect(CreatePageResponseSchema.safeParse(resp).success).toBe(true)
    })

    it('rejects responses missing required fields', () => {
      expect(CreatePageResponseSchema.safeParse({ ok: true }).success).toBe(false)
      expect(CreatePageResponseSchema.safeParse({ name: 'home' }).success).toBe(false)
    })
  })

  describe('PageSummary (GET /api/pages list shape)', () => {
    it('accepts a well-formed entry', () => {
      const entry: PageSummary = { name: 'home', route: '/', template: 'page-default' }
      expect(PageSummarySchema.safeParse(entry).success).toBe(true)
    })

    it('accepts an archived entry without a template', () => {
      // Per design-redirect-ui.md Q2 sub-decision A1: archived pages
      // may omit `template`. Summary rows reflect this — the field
      // is optional at the listing level so archived items round-trip
      // through `/api/pages` without a sentinel.
      const archived = { name: 'old-page', route: '/old-page', archived: true, aliasOf: 'new-page' }
      expect(PageSummarySchema.safeParse(archived).success).toBe(true)
    })

    it('rejects entries missing required fields', () => {
      // `name` and `route` are still required at the listing level —
      // they identify the row regardless of archive state.
      expect(PageSummarySchema.safeParse({ name: 'home' }).success).toBe(false)
      expect(PageSummarySchema.safeParse({ route: '/' }).success).toBe(false)
    })
  })

  describe('PageMetadata (optional SEO metadata on pages)', () => {
    it('accepts a fully populated metadata object', () => {
      const meta: PageMetadata = {
        title: 'My Page',
        description: 'A description',
        ogImage: 'https://example.com/img.jpg',
        canonical: 'https://example.com/my-page',
      }
      expect(PageMetadataSchema.safeParse(meta)?.success).toBe(true)
    })

    it('accepts undefined (metadata is optional on pages)', () => {
      expect(PageMetadataSchema.safeParse(undefined)?.success).toBe(true)
    })

    it('accepts an empty object (all fields optional)', () => {
      expect(PageMetadataSchema.safeParse({})?.success).toBe(true)
    })

    it('accepts partial metadata', () => {
      expect(PageMetadataSchema.safeParse({ title: 'Just a title' })?.success).toBe(true)
    })
  })
})

describe('POST /api/fragments contract', () => {
  describe('CreateFragmentRequest', () => {
    it('accepts the minimal shape the client uses', () => {
      const body: CreateFragmentRequest = { name: 'header', template: 'header-layout' }
      expect(CreateFragmentRequestSchema.safeParse(body).success).toBe(true)
    })

    it('rejects empty name', () => {
      const r = CreateFragmentRequestSchema.safeParse({ name: '', template: 'header-layout' })
      expect(r.success).toBe(false)
    })

    it('rejects empty template', () => {
      const r = CreateFragmentRequestSchema.safeParse({ name: 'header', template: '' })
      expect(r.success).toBe(false)
    })

    it('rejects missing required fields', () => {
      expect(CreateFragmentRequestSchema.safeParse({ name: 'header' }).success).toBe(false)
      expect(CreateFragmentRequestSchema.safeParse({ template: 'header-layout' }).success).toBe(false)
      expect(CreateFragmentRequestSchema.safeParse({}).success).toBe(false)
    })
  })

  describe('CreateFragmentResponse', () => {
    it('accepts the response shape the server emits', () => {
      const resp: CreateFragmentResponse = { ok: true, name: 'header' }
      expect(CreateFragmentResponseSchema.safeParse(resp).success).toBe(true)
    })

    it('rejects responses missing required fields', () => {
      expect(CreateFragmentResponseSchema.safeParse({ ok: true }).success).toBe(false)
      expect(CreateFragmentResponseSchema.safeParse({ name: 'header' }).success).toBe(false)
    })
  })

  describe('FragmentSummary (GET /api/fragments list shape)', () => {
    it('accepts a well-formed entry', () => {
      const entry: FragmentSummary = { name: 'header', template: 'header-layout' }
      expect(FragmentSummarySchema.safeParse(entry).success).toBe(true)
    })

    it('accepts an archived entry without a template', () => {
      // Same shape as PageSummary's archived case (per
      // design-redirect-ui.md Q2 sub-decision A1). Fragment redirects
      // are listed without a template in the GET /api/fragments
      // response.
      const archived = { name: 'old-header', archived: true, aliasOf: 'header' }
      expect(FragmentSummarySchema.safeParse(archived).success).toBe(true)
    })

    it('rejects entries missing required fields', () => {
      // `name` remains required at the listing level — it identifies
      // the row regardless of archive state.
      expect(FragmentSummarySchema.safeParse({ template: 'header-layout' }).success).toBe(false)
      expect(FragmentSummarySchema.safeParse({}).success).toBe(false)
    })
  })
})

describe('GET /api/templates contract', () => {
  it('accepts a well-formed summary', () => {
    const entry: TemplateSummary = { name: 'hero' }
    expect(TemplateSummarySchema.safeParse(entry).success).toBe(true)
  })

  it('rejects entries missing name', () => {
    expect(TemplateSummarySchema.safeParse({}).success).toBe(false)
  })
})

describe('GET /api/fields contract', () => {
  it('accepts a well-formed summary', () => {
    const entry: FieldSummary = { name: 'brand-color', path: '/abs/path/admin/fields/brand-color.tsx' }
    expect(FieldSummarySchema.safeParse(entry).success).toBe(true)
  })

  it('rejects entries missing required fields', () => {
    expect(FieldSummarySchema.safeParse({ name: 'brand-color' }).success).toBe(false)
    expect(FieldSummarySchema.safeParse({ path: '/abs/path' }).success).toBe(false)
  })
})

describe('GET /api/targets contract', () => {
  describe('TargetInfo', () => {
    it('accepts a well-formed entry', () => {
      const entry: TargetInfo = {
        name: 'local',
        environment: 'local',
        type: 'static',
        editable: true,
        altText: { available: false, auto: false },
        capabilities: { has: [], gaps: [] },
      }
      expect(TargetInfoSchema.safeParse(entry).success).toBe(true)
    })

    it('rejects entries missing required fields', () => {
      expect(TargetInfoSchema.safeParse({ name: 'local', environment: 'local', type: 'static' }).success).toBe(false)
      expect(TargetInfoSchema.safeParse({ environment: 'local', type: 'static', editable: true }).success).toBe(false)
      // altText is required per the v1.5 capability surface.
      expect(
        TargetInfoSchema.safeParse({ name: 'local', environment: 'local', type: 'static', editable: true }).success,
      ).toBe(false)
    })

    it('accepts altText capability with both availability and auto values', () => {
      const cases = [
        { available: false, auto: false },
        { available: true, auto: false },
        { available: true, auto: true },
      ]
      for (const altText of cases) {
        const entry: TargetInfo = {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText,
          capabilities: { has: [], gaps: [] },
        }
        expect(TargetInfoSchema.safeParse(entry).success).toBe(true)
      }
    })

    it('accepts capabilities with has + gaps populated (Cut 9 capability-gap surface)', () => {
      const entry: TargetInfo = {
        name: 'production-static',
        environment: 'production',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
        capabilities: {
          has: [],
          gaps: [
            { capability: 'redirects', reason: 'plain-static target — no worker' },
            { capability: 'gone-status', reason: 'no worker available to emit 410 Gone' },
          ],
        },
      }
      expect(TargetInfoSchema.safeParse(entry).success).toBe(true)
    })
  })

  describe('TargetEnvironment / TargetType enums', () => {
    it('TargetEnvironment accepts local, staging, production — rejects others', () => {
      expect(TargetEnvironmentSchema.safeParse('local').success).toBe(true)
      expect(TargetEnvironmentSchema.safeParse('staging').success).toBe(true)
      expect(TargetEnvironmentSchema.safeParse('production').success).toBe(true)
      // No custom environment names — this is a design-decisions.md
      // property, not a schema accident. If the server ever emits a
      // custom env value, it must widen the schema first.
      expect(TargetEnvironmentSchema.safeParse('dev').success).toBe(false)
      expect(TargetEnvironmentSchema.safeParse('prod').success).toBe(false)
    })

    it('TargetType accepts static and dynamic only', () => {
      expect(TargetTypeSchema.safeParse('static').success).toBe(true)
      expect(TargetTypeSchema.safeParse('dynamic').success).toBe(true)
      expect(TargetTypeSchema.safeParse('esi').success).toBe(false)
    })
  })
})

describe('GET /api/site contract', () => {
  it('accepts the minimal manifest the server emits', () => {
    const manifest: SiteManifest = { name: 'My Site' }
    expect(SiteManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('accepts a fully populated manifest', () => {
    const manifest: SiteManifest = {
      name: 'My Site',
      version: '1.0.0',
      locale: 'en',
      baseUrl: 'https://example.com',
      systemPages: ['404'],
    }
    expect(SiteManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('accepts the empty-target fallback shape (includes targets:{})', () => {
    // The /api/site handler returns { name: '(empty)', targets: {} }
    // when the target has no site.config.ts yet. The schema is loose so
    // the extra field passes through.
    const r = SiteManifestSchema.safeParse({ name: '(empty)', targets: {} })
    expect(r.success).toBe(true)
  })

  it('rejects manifests missing name', () => {
    expect(SiteManifestSchema.safeParse({ version: '1.0.0' }).success).toBe(false)
  })
})

describe('GET /api/dependents contract', () => {
  it('accepts a well-formed response', () => {
    const resp: DependentsResponse = { pages: ['home', 'about'], fragments: ['nav'] }
    expect(DependentsResponseSchema.safeParse(resp).success).toBe(true)
  })

  it('accepts empty arrays', () => {
    const resp: DependentsResponse = { pages: [], fragments: [] }
    expect(DependentsResponseSchema.safeParse(resp).success).toBe(true)
  })

  it('rejects responses missing required fields', () => {
    expect(DependentsResponseSchema.safeParse({ pages: [] }).success).toBe(false)
    expect(DependentsResponseSchema.safeParse({ fragments: [] }).success).toBe(false)
    expect(DependentsResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects non-string entries', () => {
    expect(DependentsResponseSchema.safeParse({ pages: [123], fragments: [] }).success).toBe(false)
  })
})

describe('GET /api/compare contract', () => {
  it('accepts a well-formed first-publish result', () => {
    const r: CompareResult = {
      added: ['pages/home', 'pages/about'],
      modified: [],
      deleted: [],
      unchanged: [],
      firstPublish: true,
      invalidTemplates: [],
    }
    expect(CompareResultSchema.safeParse(r).success).toBe(true)
  })

  it('accepts a mixed diff with invalid-template entries', () => {
    const r: CompareResult = {
      added: ['pages/new'],
      modified: ['pages/home'],
      deleted: ['pages/old'],
      unchanged: ['fragments/header'],
      firstPublish: false,
      invalidTemplates: [{ name: 'broken', errors: ['syntax error', 'no default export'] }],
    }
    expect(CompareResultSchema.safeParse(r).success).toBe(true)
  })

  it('rejects results missing any required array', () => {
    expect(
      CompareResultSchema.safeParse({
        added: [],
        modified: [],
        deleted: [],
        firstPublish: false,
        invalidTemplates: [],
      }).success,
    ).toBe(false)
  })

  it('rejects invalidTemplate entries with wrong shape', () => {
    expect(
      CompareResultSchema.safeParse({
        added: [],
        modified: [],
        deleted: [],
        unchanged: [],
        firstPublish: false,
        invalidTemplates: [{ name: 'broken' }],
      }).success,
    ).toBe(false)
  })
})

describe('POST /api/publish + /api/publish/stream contract', () => {
  describe('PublishResult', () => {
    it('accepts a successful per-target result', () => {
      const r: PublishResult = { target: 'staging', success: true, copiedFiles: 12 }
      expect(PublishResultSchema.safeParse(r).success).toBe(true)
    })

    it('accepts a failed per-target result with error message', () => {
      const r: PublishResult = { target: 'prod', success: false, error: 'network', copiedFiles: 0 }
      expect(PublishResultSchema.safeParse(r).success).toBe(true)
    })

    it('rejects missing required fields', () => {
      expect(PublishResultSchema.safeParse({ target: 'x', success: true }).success).toBe(false)
      expect(PublishResultSchema.safeParse({ success: true, copiedFiles: 0 }).success).toBe(false)
    })
  })

  describe('PublishProgress (SSE event union)', () => {
    it('accepts each of the six discriminator variants', () => {
      const events: PublishProgress[] = [
        { kind: 'start', targets: ['staging', 'prod'], itemsPerTarget: 5 },
        { kind: 'target-start', target: 'staging', total: 5 },
        { kind: 'progress', target: 'staging', current: 2, total: 5, label: 'pages/home' },
        {
          kind: 'target-result',
          result: { target: 'staging', success: true, copiedFiles: 5 },
        },
        {
          kind: 'done',
          results: [{ target: 'staging', success: true, copiedFiles: 5 }],
        },
        { kind: 'fatal', error: 'template scan failed', invalidTemplates: [{ name: 'x', errors: ['e'] }] },
      ]
      for (const ev of events) {
        expect(PublishProgressSchema.safeParse(ev).success).toBe(true)
      }
    })

    it('accepts fatal without invalidTemplates (field is optional)', () => {
      expect(PublishProgressSchema.safeParse({ kind: 'fatal', error: 'boom' }).success).toBe(true)
    })

    it('rejects events with an unknown kind', () => {
      expect(PublishProgressSchema.safeParse({ kind: 'banana', foo: 1 }).success).toBe(false)
    })

    it('rejects events with a wrong payload for their kind', () => {
      // `progress` without `current`
      expect(PublishProgressSchema.safeParse({ kind: 'progress', target: 'x', total: 5, label: 'y' }).success).toBe(
        false,
      )
      // `target-result` with a non-PublishResult result
      expect(PublishProgressSchema.safeParse({ kind: 'target-result', result: { target: 'x' } }).success).toBe(false)
    })
  })
})

describe('GET /api/history + POST /api/history/{undo,restore} contract', () => {
  describe('RevisionSummary', () => {
    it('accepts a minimal save revision', () => {
      const rev: RevisionSummary = {
        id: 'rev-1713295810000',
        timestamp: '2026-04-16T20:00:00.000Z',
        operation: 'save',
        items: ['pages/home'],
      }
      expect(RevisionSummarySchema.safeParse(rev).success).toBe(true)
    })

    it('accepts a rollback revision with all optional fields set', () => {
      const rev: RevisionSummary = {
        id: 'rev-1713295900000',
        timestamp: '2026-04-16T20:10:00.000Z',
        operation: 'rollback',
        author: 'alice',
        source: 'staging',
        items: ['pages/home', 'fragments/header'],
        message: 'Rollback to rev-1713295810000',
        restoredFrom: 'rev-1713295810000',
      }
      expect(RevisionSummarySchema.safeParse(rev).success).toBe(true)
    })

    it('rejects unknown operation values', () => {
      expect(
        RevisionSummarySchema.safeParse({
          id: 'rev-1',
          timestamp: '2026-04-16T20:00:00.000Z',
          operation: 'delete',
          items: [],
        }).success,
      ).toBe(false)
    })

    it('rejects missing required fields', () => {
      expect(
        RevisionSummarySchema.safeParse({
          id: 'rev-1',
          timestamp: '2026-04-16T20:00:00.000Z',
          operation: 'save',
          // items missing
        }).success,
      ).toBe(false)
    })
  })

  describe('ListHistoryResponse', () => {
    it('accepts an empty history', () => {
      const r: ListHistoryResponse = { revisions: [] }
      expect(ListHistoryResponseSchema.safeParse(r).success).toBe(true)
    })

    it('accepts a populated history', () => {
      const r: ListHistoryResponse = {
        revisions: [
          { id: 'rev-2', timestamp: '2026-04-16T20:10:00.000Z', operation: 'save', items: [] },
          { id: 'rev-1', timestamp: '2026-04-16T20:00:00.000Z', operation: 'publish', items: ['x'] },
        ],
      }
      expect(ListHistoryResponseSchema.safeParse(r).success).toBe(true)
    })

    it('rejects responses missing the revisions field', () => {
      expect(ListHistoryResponseSchema.safeParse({}).success).toBe(false)
    })
  })

  describe('RestoreRevisionResponse (shared by /undo and /restore)', () => {
    it('accepts a well-formed response', () => {
      const r: RestoreRevisionResponse = {
        revision: {
          id: 'rev-3',
          timestamp: '2026-04-16T20:20:00.000Z',
          operation: 'rollback',
          items: [],
          restoredFrom: 'rev-1',
        },
        restoredFrom: 'rev-1',
      }
      expect(RestoreRevisionResponseSchema.safeParse(r).success).toBe(true)
    })

    it('rejects responses missing restoredFrom', () => {
      expect(
        RestoreRevisionResponseSchema.safeParse({
          revision: { id: 'rev-3', timestamp: 't', operation: 'rollback', items: [] },
        }).success,
      ).toBe(false)
    })
  })
})

describe('POST /api/fetch contract', () => {
  it('accepts a well-formed response', () => {
    const r: FetchResponse = { success: true, copiedFiles: 3, items: ['pages/home', 'fragments/header'] }
    expect(FetchResponseSchema.safeParse(r).success).toBe(true)
  })

  it('accepts a zero-copy response', () => {
    const r: FetchResponse = { success: true, copiedFiles: 0, items: [] }
    expect(FetchResponseSchema.safeParse(r).success).toBe(true)
  })

  it('rejects responses missing required fields', () => {
    expect(FetchResponseSchema.safeParse({ success: true, copiedFiles: 0 }).success).toBe(false)
    expect(FetchResponseSchema.safeParse({ copiedFiles: 0, items: [] }).success).toBe(false)
  })
})
