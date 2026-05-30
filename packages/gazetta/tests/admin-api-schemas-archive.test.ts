/**
 * Schema refinement for archived manifests — Cut 1 of redirect-ui
 * (#444).
 *
 * Per `design-redirect-ui.md` Q2 (sub-decision A1): the persisted
 * page/fragment manifest schemas allow `template` to be absent when
 * `archived: true`. This reflects the runtime reality — the renderer
 * short-circuits archived items via `if (isArchived(page)) return
 * publishArchiveMarker(...)`, never executing a template — so the
 * archive-only manifest shape `{ archived: true, aliasOf: 'x' }` is
 * legitimate. Live manifests still require a template.
 *
 * Note: this is the PERSISTED-manifest contract. The
 * `CreatePageRequestSchema` (create-page contract) is unchanged —
 * page creation still requires a template.
 */
import { describe, expect, it } from 'vitest'
import {
  CreatePageRequestSchema,
  PageManifestSchema,
} from '../src/admin-api/schemas/pages.js'
import { FragmentManifestSchema } from '../src/admin-api/schemas/fragments.js'

describe('PageManifestSchema — archive-aware template requirement', () => {
  it('parses an archive-only manifest without a template', () => {
    const archived = { archived: true, aliasOf: 'products/featured' }
    expect(() => PageManifestSchema.parse(archived)).not.toThrow()
  })

  it('parses an archived manifest with template still present', () => {
    // Some archives carry the original template (e.g., rename redirects
    // that preserve history). Schema must accept this shape too — the
    // refinement only LOOSENS the requirement when archived, never
    // forbids template presence.
    const archivedWithTemplate = {
      archived: true,
      aliasOf: 'products/featured',
      template: 'hero',
    }
    expect(() => PageManifestSchema.parse(archivedWithTemplate)).not.toThrow()
  })

  it('rejects a live manifest without a template', () => {
    // `archived: false` is treated identically to `archived` absent
    // (per `ArchiveFields` JSDoc in `types.ts`). Both mean "live" and
    // both require a template.
    const liveMissingTemplate = { content: { title: 'Hello' } }
    expect(() => PageManifestSchema.parse(liveMissingTemplate)).toThrow()
  })

  it('rejects a manifest with archived: false but no template', () => {
    const liveExplicitlyFalse = { archived: false, content: {} }
    expect(() => PageManifestSchema.parse(liveExplicitlyFalse)).toThrow()
  })

  it('accepts a standard live manifest with template', () => {
    const live = { template: 'hero', content: { title: 'Hello' } }
    expect(() => PageManifestSchema.parse(live)).not.toThrow()
  })
})

describe('FragmentManifestSchema — archive-aware template requirement', () => {
  it('parses an archive-only manifest without a template', () => {
    const archived = { archived: true, aliasOf: 'header' }
    expect(() => FragmentManifestSchema.parse(archived)).not.toThrow()
  })

  it('rejects a live manifest without a template', () => {
    const liveMissingTemplate = { content: { label: 'Footer' } }
    expect(() => FragmentManifestSchema.parse(liveMissingTemplate)).toThrow()
  })

  it('accepts a standard live manifest with template', () => {
    const live = { template: 'footer-layout' }
    expect(() => FragmentManifestSchema.parse(live)).not.toThrow()
  })
})

describe('CreatePageRequestSchema — create-contract unchanged', () => {
  it('still rejects payloads missing template (refinement does not leak)', () => {
    // The refinement above applies to the PERSISTED manifest, not the
    // create request. Page creation still demands a template — manual
    // redirects use their own POST /api/redirects endpoint (Cut 3).
    const badCreate = { name: 'about' }
    expect(() => CreatePageRequestSchema.parse(badCreate)).toThrow()
  })

  it('rejects creates with archived flag but no template', () => {
    // Even an explicit `archived: true` on the create request should
    // fail — creation is for live pages; archives compose via the
    // redirect or archive routes, not via create.
    const badArchiveCreate = { name: 'old-page', archived: true }
    expect(() => CreatePageRequestSchema.parse(badArchiveCreate)).toThrow()
  })

  it('accepts a normal create payload', () => {
    const ok = { name: 'about', template: 'page-default' }
    expect(() => CreatePageRequestSchema.parse(ok)).not.toThrow()
  })
})
