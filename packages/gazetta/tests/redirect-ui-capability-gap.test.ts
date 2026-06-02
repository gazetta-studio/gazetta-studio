/**
 * Cut 5 — capability-gap composition for Manual Redirects.
 *
 * Per `design-redirect-ui.md` "Foundational checks" and the cut sub-
 * issue acceptance: Manual Redirects are bytes-identical on disk to
 * Rename Redirects (archive manifest with `aliasOf`, no `template`).
 * The existing capability-gap surfaces (P4 validator scanner, publish-
 * audit endpoint) already key on `archived: true` — this cut pins
 * that the composition holds when the manifest was authored via the
 * Manual Redirect path (NO preceding rename), so a future refactor
 * that tightens the validator's scope (e.g. require `template` to be
 * present) would break Manual Redirects loudly here.
 *
 * Tests:
 *   - `archive-not-supported-on-target` (P4) fires for a Manual
 *     Redirect manifest on a plain-static target. Same surface the
 *     site-health drawer reads from Cut 2's background scanner.
 *   - `POST /api/publish/audit` surfaces `capabilities` when the
 *     publish set includes a Manual Redirect manifest. Same surface
 *     PublishPanel reads to render the pre-publish capability
 *     warning.
 *
 * Per rule 26 (test-isolation paranoia): fresh memoryStorage + fresh
 * createAdminApp per test.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { archiveNotSupportedOnTarget } from '../src/validation/validators/archive-not-supported-on-target.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { PageManifest, SiteManifest } from '../src/types.js'
import type { Site } from '../src/site-loader.js'
import { createContentRoot } from '../src/content-root.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

/**
 * Manual Redirect manifest shape per design-redirect-ui.md Q2 + Cut 3
 * route implementation: archive fields set, NO template field, name
 * matches the from-route. Distinct from a Rename Redirect because no
 * preceding live page existed — operator created this manifest via
 * `POST /api/page-redirects`.
 */
function makeManualRedirectPageManifest(aliasOf: string): PageManifest {
  return {
    archived: true,
    archivedAt: '2026-06-01T10:00:00Z',
    archivedBy: 'alice@example.com',
    aliasOf,
    // No template field — the schema refinement (Cut 1) makes
    // template optional when archived: true.
  } as PageManifest
}

describe('Cut 5 — Manual Redirects compose with the four-point capability-gap UX', () => {
  describe('surface #3 (validator scanner) — P4 fires for Manual Redirect on plain-static', () => {
    it('archive-not-supported-on-target warns for a Manual Redirect manifest on a plain-static target', async () => {
      const storage = memoryStorage()
      const manifest: SiteManifest = {
        name: 'test-site',
        targets: {
          'production-static': { storage, type: 'static' },
        },
      }
      const site: Site = {
        manifest,
        pages: new Map(),
        pageLocales: new Map(),
        fragments: new Map(),
        fragmentLocales: new Map(),
        contentRoot: createContentRoot(storage, ''),
        storage,
        siteDir: '',
        templatesDir: '',
      } as Site

      const issues = await archiveNotSupportedOnTarget.validate({
        stage: 'background',
        site,
        contentRoot: site.contentRoot,
        storage,
        scope: {
          kind: 'background',
          item: {
            kind: 'page',
            name: 'old-promo',
            itemPath: 'pages/old-promo/page.json',
          },
          manifest: makeManualRedirectPageManifest('home'),
        },
      })

      // Manual Redirects are archived manifests; the P4 validator
      // contract — warn-severity per archived item that would lose
      // its redirect on a gapped target — applies regardless of
      // whether the archive came from rename or from a Manual
      // Redirect create.
      expect(issues.length).toBeGreaterThan(0)
      expect(issues[0].validator).toBe('archive-not-supported-on-target')
      expect(issues[0].severity).toBe('warn')
      // The gapped target name surfaces in the message so the site-
      // health drawer can group issues per target.
      expect(issues[0].message).toContain('production-static')
    })

    it('archive-not-supported-on-target does NOT warn when the only target is worker-served', async () => {
      const storage = memoryStorage()
      const manifest: SiteManifest = {
        name: 'test-site',
        targets: {
          // type: dynamic means hasWorker=true → no gaps per
          // inspectTarget().
          local: { storage, type: 'dynamic' },
        },
      }
      const site: Site = {
        manifest,
        pages: new Map(),
        pageLocales: new Map(),
        fragments: new Map(),
        fragmentLocales: new Map(),
        contentRoot: createContentRoot(storage, ''),
        storage,
        siteDir: '',
        templatesDir: '',
      } as Site

      const issues = await archiveNotSupportedOnTarget.validate({
        stage: 'background',
        site,
        contentRoot: site.contentRoot,
        storage,
        scope: {
          kind: 'background',
          item: {
            kind: 'page',
            name: 'old-promo',
            itemPath: 'pages/old-promo/page.json',
          },
          manifest: makeManualRedirectPageManifest('home'),
        },
      })

      // Worker-served target — no capability gap → no warning.
      // Pins that the validator's logic is target-capability driven,
      // not Manual-Redirect-blind.
      expect(issues).toEqual([])
    })
  })

  describe('surface #4 (publish gate) — /api/publish/audit includes capabilities for Manual Redirects', () => {
    let app: Hono
    let storage: MemoryStorage

    beforeEach(() => {
      storage = memoryStorage()
      // Seed a Manual Redirect manifest at pages/old-promo. The
      // alias target (`home`) is live so the manifest passes
      // referential validity; what we're testing is whether the
      // publish-audit response surfaces the capability gap for the
      // destination target.
      storage.seed({
        'pages/old-promo/page.json': JSON.stringify(makeManualRedirectPageManifest('home')),
        'pages/home/page.json': JSON.stringify({
          template: 'page-default',
          content: { title: 'Home' },
        }),
      })

      const targetConfigs = {
        local: {
          storage,
          type: 'dynamic' as const,
          environment: 'local' as const,
          editable: true,
        },
        'production-static': {
          storage,
          type: 'static' as const,
          environment: 'production' as const,
          // No `redirects.format` → plain-static → both 'redirects'
          // and 'gone-status' missing.
        },
      }

      const source = createSourceContext({
        storage,
        siteDir: '',
        projectSiteDir: '/test-project',
        manifest: {
          name: 'test-site',
          targets: targetConfigs,
        },
      })

      app = createAdminApp({
        source,
        siteDir: '/test-project',
        templatesDir: '/test-project/templates',
        targets: new Map([
          ['local', storage],
          ['production-static', storage],
        ]),
        targetConfigs,
        disableCacheStatsLogger: true,
        // Registry of one — composes with the publish gate even
        // when other validators aren't wired.
        validators: createValidatorRegistry([archiveNotSupportedOnTarget]),
      })
    })

    it('publish-audit surfaces capabilities when a Manual Redirect is in the publish set on a gapped target', async () => {
      const res = await app.request('/api/publish/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'production-static',
          items: [{ kind: 'page', name: 'old-promo' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        capabilities?: {
          has: string[]
          gaps: Array<{ capability: string; reason: string }>
        }
      }

      // The publish-gate's includesArchived predicate checks the
      // manifest's archived field — Manual Redirects have it set
      // identically to renames, so the capability surfaces here.
      expect(body.capabilities).toBeDefined()
      expect(body.capabilities!.has).not.toContain('redirects')
      const gapKinds = body.capabilities!.gaps.map(g => g.capability)
      expect(gapKinds).toContain('redirects')
      expect(gapKinds).toContain('gone-status')
    })

    it('publish-audit omits capabilities when only live items are in the publish set (conditional surface)', async () => {
      // Publish only the live `home` page (not the Manual Redirect)
      // → the includesArchived predicate sees no archived items →
      // capabilities omitted. Pins the "only surfaces when relevant"
      // contract from publish.ts so the dialog doesn't spam warnings
      // for non-redirect publishes.
      const res = await app.request('/api/publish/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'production-static',
          items: [{ kind: 'page', name: 'home' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { capabilities?: unknown }
      expect(body.capabilities).toBeUndefined()
    })
  })
})
