/**
 * Component tests for SiteTree.vue.
 *
 * Scope: structural rendering — the daily-author site tree's contracts that
 * the component is exclusively responsible for. Pins:
 *   - Pages / fragments / system-pages sections render independently
 *   - Archive filter toggle's absence-as-state (Krug, design-soft-delete.md
 *     Q7 J1): hidden at count = 0, visible with `(N)` badge when N > 0
 *   - Archived items hidden by default; visible after toggle
 *   - Alias suffix `→ {aliasOf}` vs pure-soft-delete `(archived)` suffix
 *     (design-soft-delete.md / design-redirect-ui.md)
 *   - Locale badges: flat at ≤3, `+N` overflow with title attribute (i18n)
 *   - Selection routes to /pages/:name or /fragments/:name
 *   - "+ New page" / "+ New fragment" / "+ New redirect" affordances exist
 *     (design-redirect-ui.md Q3 lock — Redirect is a first-class create entry)
 *   - Delete button carries an accessible aria-label (a11y)
 *
 * Out of scope:
 *   - Drag/drop reorder (design-component-ordering.md — covered separately)
 *   - The create-dialog modal internals (each has its own component test)
 *   - Dirty-dot from publishStatus (publishStatus.refresh fetches; we mock
 *     it to no-op so the tree mounts cleanly without exercising compare)
 *   - validationScanner store seeding (issue dots have no issues by default)
 *
 * Uses real Pinia + a real vue-router memory instance per the existing pattern
 * in ActiveTargetIndicator.test.ts + ComponentTree.test.ts. PagesApi /
 * FragmentsApi mocked via `provide` per ComponentTree.test.ts's DI pattern.
 * FragmentBlastRadius + create dialogs stubbed — they have their own tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import PrimeVue from 'primevue/config'
import SiteTree from '../src/client/components/SiteTree.vue'
import { PAGES_API, FRAGMENTS_API, type PagesApi, type FragmentsApi } from '../src/client/composables/api.js'
import { useSiteStore } from '../src/client/stores/site.js'
import { usePublishStatusStore } from '../src/client/stores/publishStatus.js'
import type { PageSummary, FragmentSummary, SiteManifest } from '../src/client/api/client.js'

function fakePagesApi(): PagesApi {
  return {
    getPages: vi.fn(),
    getPage: vi.fn(),
    createPage: vi.fn(),
    deletePage: vi.fn().mockResolvedValue({ ok: true }),
    updatePage: vi.fn(),
  } as unknown as PagesApi
}

function fakeFragmentsApi(): FragmentsApi {
  return {
    getFragments: vi.fn(),
    getFragment: vi.fn(),
    createFragment: vi.fn(),
    deleteFragment: vi.fn().mockResolvedValue({ ok: true }),
    updateFragment: vi.fn(),
    getDependents: vi.fn(),
  } as unknown as FragmentsApi
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
}

interface SeedOpts {
  pages?: PageSummary[]
  fragments?: FragmentSummary[]
  manifest?: Partial<SiteManifest>
}

function seedSite({ pages = [], fragments = [], manifest = {} }: SeedOpts) {
  const site = useSiteStore()
  site.pages = pages
  site.fragments = fragments
  site.manifest = {
    name: 'test',
    targets: [],
    locales: undefined,
    systemPages: undefined,
    ...manifest,
  } as SiteManifest
  // Prevent publishStatus.refresh from calling out to /api/compare on
  // mount — we're not testing the dirty-dot path here.
  vi.spyOn(usePublishStatusStore(), 'refresh').mockResolvedValue(undefined)
  return site
}

function mountTree(router: Router = makeRouter()) {
  return mount(SiteTree, {
    global: {
      plugins: [PrimeVue, router],
      provide: {
        [PAGES_API as symbol]: fakePagesApi(),
        [FRAGMENTS_API as symbol]: fakeFragmentsApi(),
      },
      stubs: {
        CreatePageDialog: true,
        CreateFragmentDialog: true,
        CreateRedirectDialog: true,
        FragmentBlastRadius: true,
      },
    },
  })
}

describe('SiteTree', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('section rendering', () => {
    it('renders one row per non-system page under the Pages section', () => {
      // Decision: assertion targets per-page testids derived from `site.pages`.
      // Counterfactual: if `contentPages` accidentally included fragments
      //   (kind mix-up), `site-fragment-header` would appear with a page testid
      //   prefix and this test would fail.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'about', route: '/about', template: 'page-default' },
        ],
        fragments: [{ name: 'header', template: 'header-layout' }],
      })
      const w = mountTree()
      expect(w.find('[data-testid="site-page-home"]').exists()).toBe(true)
      expect(w.find('[data-testid="site-page-about"]').exists()).toBe(true)
      // The fragment must NOT appear with a page-prefixed testid.
      expect(w.find('[data-testid="site-page-header"]').exists()).toBe(false)
    })

    it('renders one row per fragment under the Fragments section', () => {
      // Decision: assertion mirrors the page test inversely.
      // Counterfactual: if the fragments computed reused the pages filter
      //   chain, fragments wouldn't render. This catches accidental cross-wiring.
      seedSite({
        pages: [{ name: 'home', route: '/', template: 'page-default' }],
        fragments: [
          { name: 'header', template: 'header-layout' },
          { name: 'footer', template: 'footer-layout' },
        ],
      })
      const w = mountTree()
      expect(w.find('[data-testid="site-fragment-header"]').exists()).toBe(true)
      expect(w.find('[data-testid="site-fragment-footer"]').exists()).toBe(true)
    })

    it('renders system pages in a separate section (per site.manifest.systemPages)', () => {
      // Decision: pin the systemPageNames filter contract.
      // Counterfactual: if `systemPages` included content pages, the section
      //   divider would appear when the manifest declares none. Direct check
      //   on the section-divider DOM verifies the split exists when configured.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'sitemap', route: '/sitemap.xml', template: 'sitemap' },
        ],
        manifest: { systemPages: ['sitemap'] },
      })
      const w = mountTree()
      expect(w.find('[data-testid="site-page-home"]').exists()).toBe(true)
      expect(w.find('[data-testid="site-page-sitemap"]').exists()).toBe(true)
      // The presence of section-divider markup separates content pages
      // from system pages. Without `systemPages` declared, no divider.
      expect(w.find('.section-divider').exists()).toBe(true)
    })

    it('omits the system-pages divider when site.manifest declares no systemPages', () => {
      // Decision: counterfactual paired with the preceding test — confirms
      //   the divider's rendering is driven by `systemPages.length`, not
      //   always-on.
      seedSite({
        pages: [{ name: 'home', route: '/', template: 'page-default' }],
        manifest: { systemPages: [] },
      })
      const w = mountTree()
      expect(w.find('.section-divider').exists()).toBe(false)
    })
  })

  describe('archive filter toggle (design-soft-delete.md Q7 J1 — absence-as-state)', () => {
    it('hides the "Show archived" toggle when archivedCount is 0', () => {
      // Decision: pins the Krug lock. The toggle is gated on
      //   `archivedCount > 0`. Counterfactual: an always-shown toggle
      //   reading "(0)" would violate the lock and this test would fail.
      seedSite({
        pages: [{ name: 'home', route: '/', template: 'page-default' }],
        fragments: [{ name: 'header', template: 'header-layout' }],
      })
      const w = mountTree()
      expect(w.find('[data-testid="archive-toggle"]').exists()).toBe(false)
    })

    it('shows the toggle with "(N)" badge text when archive items exist', () => {
      // Decision: pins the locked label format.
      // Counterfactual: if the label dropped the count, or used plural-only,
      //   the substring assertion fails.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'old', route: '/old', archived: true },
        ],
        fragments: [{ name: 'header-old', archived: true, aliasOf: 'header' }],
      })
      const w = mountTree()
      const toggle = w.find('[data-testid="archive-toggle"]')
      expect(toggle.exists()).toBe(true)
      // archivedCount = 1 page + 1 fragment = 2
      expect(toggle.text()).toContain('(2)')
    })

    it('counts archived pages AND fragments (not pages alone)', () => {
      // Decision: pins archivedCount's sum across both surfaces.
      //   Counterfactual: if the count only summed pages, "(3)" would render
      //   as "(2)" with 1 archived fragment, and the test would fail. The
      //   ratio (more fragments than pages) exposes the failure mode.
      seedSite({
        pages: [{ name: 'home', route: '/', template: 'page-default' }],
        fragments: [
          { name: 'header-v1', archived: true, aliasOf: 'header' },
          { name: 'footer-v1', archived: true, aliasOf: 'footer' },
          { name: 'header', template: 'header-layout' },
        ],
      })
      const w = mountTree()
      expect(w.find('[data-testid="archive-toggle"]').text()).toContain('(2)')
    })

    it('hides archived items from the tree by default (showArchived=false)', () => {
      // Decision: pins the locked default. `contentPages` filters
      //   `showArchived.value || p.archived !== true`. Default false →
      //   archived items absent.
      // Counterfactual: if the default were true, the archived row would
      //   render and the test would fail.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'landing', route: '/landing', archived: true, aliasOf: 'home' },
        ],
      })
      const w = mountTree()
      expect(w.find('[data-testid="site-page-home"]').exists()).toBe(true)
      expect(w.find('[data-testid="site-page-landing"]').exists()).toBe(false)
    })

    it('reveals archived items after the toggle checkbox is checked', async () => {
      // Decision: pins the showArchived state-flip behavior.
      //   Counterfactual: if the input wasn't wired to showArchived via
      //   v-model, the archived row would stay hidden after click.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'landing', route: '/landing', archived: true, aliasOf: 'home' },
        ],
      })
      const w = mountTree()
      const input = w.find('[data-testid="archive-toggle-input"]')
      await input.setValue(true)
      expect(w.find('[data-testid="site-page-landing"]').exists()).toBe(true)
    })
  })

  describe('archived row visual suffix (design-soft-delete.md Q7 J1)', () => {
    it('renders "→ {aliasOf}" suffix for archived pages with an alias', async () => {
      // Decision: pins the alias-arrow visual contract from
      //   design-soft-delete.md Q7. Counterfactual: if the template
      //   accidentally rendered "(archived)" instead of "→ home" for
      //   alias-bearing archives, the assertion fails. Both the arrow
      //   AND the target name are checked.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'landing', route: '/landing', archived: true, aliasOf: 'home' },
        ],
      })
      const w = mountTree()
      await w.find('[data-testid="archive-toggle-input"]').setValue(true)
      const row = w.find('[data-testid="site-page-landing"]')
      expect(row.text()).toContain('→')
      expect(row.text()).toContain('home')
      expect(row.text()).not.toContain('(archived)')
    })

    it('renders "(archived)" suffix for pure soft-delete (no aliasOf)', async () => {
      // Decision: pins the pure-soft-delete fallback. Counterfactual: if
      //   the template's v-else-if branched on truthy aliasOf rather than
      //   archived, this row would render no suffix at all.
      seedSite({
        pages: [
          { name: 'home', route: '/', template: 'page-default' },
          { name: 'old-post', route: '/old', archived: true },
        ],
      })
      const w = mountTree()
      await w.find('[data-testid="archive-toggle-input"]').setValue(true)
      const row = w.find('[data-testid="site-page-old-post"]')
      expect(row.text()).toContain('(archived)')
      expect(row.text()).not.toContain('→')
    })

    it('renders "→ @{aliasOf}" with the @ prefix for archived fragments', async () => {
      // Decision: pins fragment-specific suffix (template line 252:
      //   `→ @{{ node.aliasOf }}`). Counterfactual: dropping the @ would
      //   conflate page-aliases (no @) with fragment-aliases (with @) in
      //   the tree — visually confusing. The @ is the load-bearing differentiator.
      seedSite({
        pages: [],
        fragments: [
          { name: 'header', template: 'header-layout' },
          { name: 'old-header', archived: true, aliasOf: 'header' },
        ],
      })
      const w = mountTree()
      await w.find('[data-testid="archive-toggle-input"]').setValue(true)
      const row = w.find('[data-testid="site-fragment-old-header"]')
      expect(row.text()).toContain('→ @header')
    })
  })

  describe('locale badges (design-i18n.md)', () => {
    it('renders each locale flat when locales.length <= 3', () => {
      // Decision: pins the ≤3 flat-list branch in the template
      //   (`v-if="node.locales.length <= 3"`). Counterfactual: an off-by-one
      //   in the conditional would route 3 locales through the overflow
      //   path; we'd see "+N" instead of three separate badges.
      seedSite({
        pages: [
          {
            name: 'home',
            route: '/',
            template: 'page-default',
            locales: ['en', 'fr', 'de'],
          },
        ],
      })
      const w = mountTree()
      const text = w.find('[data-testid="site-page-home"]').text()
      expect(text).toContain('EN')
      expect(text).toContain('FR')
      expect(text).toContain('DE')
      expect(text).not.toMatch(/\+\d/)
    })

    it('collapses to first locale + "+N" badge when locales.length > 3', () => {
      // Decision: pins the overflow branch and its title-attr contract
      //   (`:title="node.locales.map(l => l.toUpperCase()).join(', ')"`).
      //   Counterfactual: rendering all 4 inline would be a regression of
      //   the design intent (tight site tree).
      seedSite({
        pages: [
          {
            name: 'home',
            route: '/',
            template: 'page-default',
            locales: ['en', 'fr', 'de', 'ja'],
          },
        ],
      })
      const w = mountTree()
      const text = w.find('[data-testid="site-page-home"]').text()
      expect(text).toContain('EN')
      expect(text).toContain('+3')
      // The title attribute carries all locale codes for hover discovery.
      const overflow = w.find('[data-testid="site-page-home"] .locale-count')
      expect(overflow.attributes('title')).toBe('EN, FR, DE, JA')
    })
  })

  describe('selection (router navigation)', () => {
    it('navigates to /pages/{name} when a page row is clicked', async () => {
      // Decision: pins the route-prefix branch
      //   (`prefix = node.type === 'page' ? '/pages' : '/fragments'`).
      //   Counterfactual: if the prefix were swapped, the spy call args
      //   would mismatch. Spy on router.push captures the exact path.
      const router = makeRouter()
      const push = vi.spyOn(router, 'push').mockResolvedValue(undefined)
      seedSite({ pages: [{ name: 'home', route: '/', template: 'page-default' }] })
      const w = mountTree(router)
      await w.find('[data-testid="site-page-home"]').trigger('click')
      expect(push).toHaveBeenCalledWith('/pages/home')
    })

    it('navigates to /fragments/{name} when a fragment row is clicked', async () => {
      // Decision: pins the inverse branch. Counterfactual: a hardcoded
      //   "/pages" prefix would route fragment clicks to the wrong section
      //   and break preview iframe routing downstream.
      const router = makeRouter()
      const push = vi.spyOn(router, 'push').mockResolvedValue(undefined)
      seedSite({ fragments: [{ name: 'header', template: 'header-layout' }] })
      const w = mountTree(router)
      await w.find('[data-testid="site-fragment-header"]').trigger('click')
      expect(push).toHaveBeenCalledWith('/fragments/header')
    })
  })

  describe('create affordances (design-redirect-ui.md Q3)', () => {
    it('renders "New page", "New fragment", and "New redirect" buttons', () => {
      // Decision: pins design-redirect-ui.md Q3's lock — Redirect is a
      //   first-class create entry peer to Page and Fragment. Counterfactual:
      //   omitting any of the three breaks the locked SiteTree affordance row
      //   from the Redirect UI design doc.
      seedSite({ pages: [], fragments: [] })
      const w = mountTree()
      expect(w.find('[data-testid="new-page"]').exists()).toBe(true)
      expect(w.find('[data-testid="new-fragment"]').exists()).toBe(true)
      expect(w.find('[data-testid="sitetree-new-redirect-button"]').exists()).toBe(true)
    })
  })

  describe('accessibility', () => {
    it("attaches an accessible aria-label to each row's delete button", () => {
      // Decision: pins the a11y contract — delete buttons hover-only
      //   visible (opacity: 0 in CSS) need an aria-label to remain
      //   discoverable to screen readers and keyboard users. Counterfactual:
      //   a label-less icon button would fail this assertion and break
      //   non-mouse navigation.
      seedSite({
        pages: [{ name: 'home', route: '/', template: 'page-default' }],
        fragments: [{ name: 'header', template: 'header-layout' }],
      })
      const w = mountTree()
      const pageDelete = w.find('[data-testid="delete-page-home"]')
      const fragDelete = w.find('[data-testid="delete-fragment-header"]')
      expect(pageDelete.attributes('aria-label')).toBe('Delete page home')
      expect(fragDelete.attributes('aria-label')).toBe('Delete fragment header')
    })
  })
})
