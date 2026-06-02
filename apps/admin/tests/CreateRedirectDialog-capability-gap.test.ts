/**
 * Cut 5 — CreateRedirectDialog capability-gap badges.
 *
 * Pins the Cut 5 acceptance criteria from issue #448. Per
 * `design-redirect-ui.md` "Foundational checks" → existing four-point
 * capability-gap UX pattern (Q10 lock of design-soft-delete.md). The
 * dialog mirrors ArchiveModal's per-target capability badges so the
 * author sees the gap BEFORE confirming the redirect.
 *
 * What's pinned:
 *   - Plain-static target (no worker, no redirects.format) → dialog
 *     renders a capability-gap warning row identifying that target.
 *   - Worker-served / static-with-redirects target → no gap warning
 *     (Krug "absence is the state"; only render rows that need
 *     attention).
 *   - Submit succeeds on a target-set that includes a plain-static
 *     gap — the gap is informational, NOT blocking. Operator can
 *     proceed knowing the gap; the four-point pattern handles
 *     downstream surfaces (validator scanner, publish gate).
 *
 * Mocking note: the dialog loads /api/targets at mount-time via the
 * direct `api` import (mirrors ArchiveModal). vi.spyOn on api.getTargets
 * stubs the load without touching component injection.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import CreateRedirectDialog from '../src/client/components/CreateRedirectDialog.vue'
import { useSiteStore } from '../src/client/stores/site.js'
import { REDIRECTS_API, type RedirectsApi } from '../src/client/composables/api.js'
import { api, type CreateRedirectResponse, type TargetInfo } from '../src/client/api/client.js'

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList
  }
})

function makeRedirectsApi(overrides: Partial<RedirectsApi> = {}): RedirectsApi {
  return {
    createPageRedirect: vi.fn().mockRejectedValue(new Error('not stubbed: createPageRedirect')),
    createFragmentRedirect: vi.fn().mockRejectedValue(new Error('not stubbed: createFragmentRedirect')),
    ...overrides,
  }
}

function successResponse(overrides: Partial<CreateRedirectResponse> = {}): CreateRedirectResponse {
  return {
    ok: true,
    from: 'old-products',
    to: 'products/featured',
    kind: 'page',
    route: '/old-products',
    targetRoute: '/products/featured',
    ...overrides,
  }
}

function seedSite() {
  const site = useSiteStore()
  site.pages = [
    { name: 'products/featured', route: '/products/featured', template: 'product', dir: 'pages' } as any,
    { name: 'home', route: '/', template: 'home', dir: 'pages' } as any,
  ]
  site.fragments = []
  return site
}

function mountDialog(api: RedirectsApi) {
  return mount(CreateRedirectDialog, {
    props: { visible: true },
    attachTo: document.body,
    global: {
      plugins: [PrimeVue],
      provide: { [REDIRECTS_API as symbol]: api },
    },
  })
}

function plainStaticTarget(name: string): TargetInfo {
  // Plain-static: type=static, no redirects.format, no worker → both
  // 'redirects' and 'gone-status' capabilities missing per
  // inspectTarget().
  return {
    name,
    environment: 'production',
    type: 'static',
    editable: false,
    altText: { available: false, auto: false },
    capabilities: {
      has: [],
      gaps: [
        {
          capability: 'redirects',
          reason:
            "plain-static target has no worker and no `redirects.format` configured; archived URLs return the host's natural 404 instead of a 301 redirect",
        },
        {
          capability: 'gone-status',
          reason:
            "no worker runtime available to emit `410 Gone` for archived-no-alias items; falls back to the host's natural 404",
        },
      ],
    },
  }
}

function workerServedTarget(name: string, environment: TargetInfo['environment'] = 'local'): TargetInfo {
  // Worker-served (type=dynamic) → has redirects + gone-status.
  return {
    name,
    environment,
    type: 'dynamic',
    editable: environment === 'local',
    altText: { available: false, auto: false },
    capabilities: {
      has: ['redirects', 'gone-status'],
      gaps: [],
    },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('CreateRedirectDialog — capability-gap badges (Cut 5)', () => {
  it('plain-static target → dialog renders a capability-gap warning row identifying the target', async () => {
    seedSite()
    vi.spyOn(api, 'getTargets').mockResolvedValue([
      workerServedTarget('local', 'local'),
      plainStaticTarget('production-static'),
    ])

    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()
    await wrapper.vm.$nextTick()

    // The gap-warning surface marks the section so authors can see
    // "Some targets won't emit redirects" at a glance.
    const gapSection = document.querySelector('[data-testid="redirect-capability-gaps"]')
    expect(gapSection).not.toBeNull()
    // The plain-static target is named explicitly — operator can map
    // the warning to their config without help text.
    expect(gapSection!.textContent ?? '').toContain('production-static')
    // The gap reason surfaces inline; operator sees WHY without
    // hovering or clicking through (Krug — no help-tooltip-as-bandaid).
    expect(gapSection!.textContent?.toLowerCase() ?? '').toMatch(/redirect|301|natural 404/)

    wrapper.unmount()
  })

  it('worker-served target only → no capability-gap warning rendered (absence is the state)', async () => {
    seedSite()
    vi.spyOn(api, 'getTargets').mockResolvedValue([workerServedTarget('local', 'local')])

    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()
    await wrapper.vm.$nextTick()

    // Krug rule 23 — only render rows that need attention. With
    // every configured target capable of emitting 301/410, the
    // capability-gap section is absent.
    expect(document.querySelector('[data-testid="redirect-capability-gaps"]')).toBeNull()

    wrapper.unmount()
  })

  it('submit succeeds when a plain-static target is in the gap list (informational, not blocking)', async () => {
    seedSite()
    vi.spyOn(api, 'getTargets').mockResolvedValue([
      workerServedTarget('local', 'local'),
      plainStaticTarget('production-static'),
    ])
    const createPage = vi.fn().mockResolvedValue(successResponse())
    const api2 = makeRedirectsApi({ createPageRedirect: createPage })

    const wrapper = mountDialog(api2)
    await flushPromises()
    await wrapper.vm.$nextTick()

    // Sanity — the gap warning IS rendered (the precondition of
    // this test).
    expect(document.querySelector('[data-testid="redirect-capability-gaps"]')).not.toBeNull()

    // Fill the inputs + submit. The gap row is informational only;
    // the submit button stays enabled and the POST fires.
    const fromInput = document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement
    const toInput = document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement
    fromInput.value = '/old-products'
    fromInput.dispatchEvent(new Event('input'))
    toInput.value = 'products/featured'
    toInput.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()

    const submit = document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement
    submit.click()
    await flushPromises()

    // Submit fired; gap was informational, not gating.
    expect(createPage).toHaveBeenCalledTimes(1)
    expect(createPage).toHaveBeenCalledWith({ from: '/old-products', to: 'products/featured' }, undefined)

    wrapper.unmount()
  })
})
