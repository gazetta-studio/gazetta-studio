/**
 * Cut 4 — CreateRedirectDialog tests.
 *
 * Pins the locked behavior from `design-redirect-ui.md` Q2/Q3/Q4 + the
 * cut sub-issue acceptance criteria + the reviewer's prior-attempt
 * note (handleResolve must actually call the API with onConflict; Esc
 * key must close the dialog).
 *
 *   - Kind toggle (page | fragment) drives which redirects API method
 *     fires and which autocomplete list is shown.
 *   - "Redirect from" / "Redirect to" inputs render Krug-style preview
 *     of the resolved route.
 *   - Submit POSTs to the right kind-specific endpoint with the
 *     normalized body `{ from, to }`.
 *   - On 409 LIVE_NAME_CONFLICT → inline error visible.
 *   - On 409 ARCHIVED_NAME_CONFLICT → dialog body morphs to
 *     ArchivedNameConflictPrompt; clicking a resolution option re-
 *     issues the POST with the chosen `onConflict` mode.
 *   - On 409 ALIAS_TARGET_NOT_FOUND → inline error visible.
 *   - On 400 INVALID (from='home' edge case) → server message inline.
 *   - Esc key closes the dialog.
 *   - Cancel button emits close.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import CreateRedirectDialog from '../src/client/components/CreateRedirectDialog.vue'
import { useSiteStore } from '../src/client/stores/site.js'
import { REDIRECTS_API, type RedirectsApi } from '../src/client/composables/api.js'
import {
  ArchivedNameConflictError,
  type ArchivedNameConflictDetails,
  type CreateRedirectResponse,
} from '../src/client/api/client.js'

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
  // Seed available live pages + fragments for autocomplete.
  site.pages = [
    { name: 'products/featured', route: '/products/featured', template: 'product', dir: 'pages' } as any,
    { name: 'home', route: '/', template: 'home', dir: 'pages' } as any,
  ]
  site.fragments = [
    { name: 'header', template: 'header-layout', dir: 'fragments' } as any,
    { name: 'footer', template: 'footer-layout', dir: 'fragments' } as any,
  ]
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

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('CreateRedirectDialog', () => {
  it('renders the dialog with both from + to inputs and submit button', async () => {
    seedSite()
    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()
    expect(document.querySelector('[data-testid="create-redirect-modal"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="create-redirect-from-input"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="create-redirect-to-input"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="create-redirect-submit"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('shows resolved-route preview for the from input', async () => {
    seedSite()
    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()
    const fromInput = document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement
    fromInput.value = '/old-products'
    fromInput.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    expect(document.body.textContent ?? '').toContain('/old-products')
    wrapper.unmount()
  })

  it('shows resolved-route preview for the to input', async () => {
    seedSite()
    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()
    const toInput = document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement
    toInput.value = 'products/featured'
    toInput.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    expect(document.body.textContent ?? '').toContain('/products/featured')
    wrapper.unmount()
  })

  it('submit calls createPageRedirect with normalized body when kind is page (default)', async () => {
    seedSite()
    const createPage = vi.fn().mockResolvedValue(successResponse())
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

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

    expect(createPage).toHaveBeenCalledTimes(1)
    expect(createPage).toHaveBeenCalledWith({ from: '/old-products', to: 'products/featured' }, undefined)
    wrapper.unmount()
  })

  it('submit calls createFragmentRedirect when kind is fragment', async () => {
    seedSite()
    const createFrag = vi
      .fn()
      .mockResolvedValue(successResponse({ kind: 'fragment', from: 'old-header', to: 'header' }))
    const api = makeRedirectsApi({ createFragmentRedirect: createFrag })
    const wrapper = mountDialog(api)
    await flushPromises()

    // Switch to fragment kind. Each toggle renders RadioButton — find by data-testid value.
    const fragmentRadio = document.querySelector(
      '[data-testid="create-redirect-kind-fragment"] input[type="radio"]',
    ) as HTMLInputElement
    fragmentRadio.click()
    await wrapper.vm.$nextTick()

    const fromInput = document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement
    const toInput = document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement
    fromInput.value = 'old-header'
    fromInput.dispatchEvent(new Event('input'))
    toInput.value = 'header'
    toInput.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()

    const submit = document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement
    submit.click()
    await flushPromises()

    expect(createFrag).toHaveBeenCalledTimes(1)
    expect(createFrag).toHaveBeenCalledWith({ from: 'old-header', to: 'header' }, undefined)
    wrapper.unmount()
  })

  it('on 409 LIVE_NAME_CONFLICT shows inline error', async () => {
    seedSite()
    const createPage = vi.fn().mockRejectedValue(new Error('The page "products" already exists as live content.'))
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

    ;(document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement).value = 'products'
    document.querySelector('[data-testid="create-redirect-from-input"]')!.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement).value =
      'products/featured'
    document.querySelector('[data-testid="create-redirect-to-input"]')!.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;(document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(document.body.textContent ?? '').toContain('already exists')
    wrapper.unmount()
  })

  it('on 409 ARCHIVED_NAME_CONFLICT morphs to ArchivedNameConflictPrompt', async () => {
    seedSite()
    const conflict: ArchivedNameConflictDetails = {
      kind: 'page',
      name: 'old-products',
      archivedAt: '2026-04-01T10:00:00Z',
      archivedBy: 'alice',
      aliasOf: 'discontinued',
    }
    const createPage = vi.fn().mockRejectedValueOnce(new ArchivedNameConflictError(conflict))
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

    ;(document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement).value = 'old-products'
    document.querySelector('[data-testid="create-redirect-from-input"]')!.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement).value =
      'products/featured'
    document.querySelector('[data-testid="create-redirect-to-input"]')!.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;(document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    // The morph swaps the dialog body to ArchivedNameConflictPrompt;
    // its testid is `archived-name-conflict-prompt`.
    expect(document.querySelector('[data-testid="archived-name-conflict-prompt"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('clicking Restore in the morphed prompt re-issues POST with onConflict=restore', async () => {
    seedSite()
    const conflict: ArchivedNameConflictDetails = {
      kind: 'page',
      name: 'old-products',
      aliasOf: 'discontinued',
    }
    // First call throws ARCHIVED_NAME_CONFLICT; second call (resolution) returns success.
    const createPage = vi
      .fn()
      .mockRejectedValueOnce(new ArchivedNameConflictError(conflict))
      .mockResolvedValueOnce(successResponse({ from: 'old-products', to: 'products/featured' }))
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

    ;(document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement).value = 'old-products'
    document.querySelector('[data-testid="create-redirect-from-input"]')!.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement).value =
      'products/featured'
    document.querySelector('[data-testid="create-redirect-to-input"]')!.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;(document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    // Morph happened. Click the default Restore option's Continue button.
    const restoreContinue = document.querySelector('[data-testid="conflict-continue-restore"]') as HTMLButtonElement
    expect(restoreContinue).not.toBeNull()
    restoreContinue.click()
    await flushPromises()

    expect(createPage).toHaveBeenCalledTimes(2)
    // Second call carries the operator-chosen resolution mode.
    expect(createPage).toHaveBeenNthCalledWith(
      2,
      { from: 'old-products', to: 'products/featured' },
      { onConflict: 'restore' },
    )
    wrapper.unmount()
  })

  it('on conflict-resolution failure surfaces error inline AND keeps the conflict prompt visible', async () => {
    // Regression test for #485. The component's docstring (handleResolve)
    // promises: "On error, surface the message in place; the conflict
    // prompt stays so the author can pick differently." Without the fix,
    // the inline error lived inside the form branch (v-else) and was
    // invisible while the conflict prompt was rendered.
    seedSite()
    const conflict: ArchivedNameConflictDetails = {
      kind: 'page',
      name: 'old-products',
      aliasOf: 'discontinued',
    }
    // First call: 409 ARCHIVED_NAME_CONFLICT → morph to prompt.
    // Second call (resolution attempt): non-archived error → must show
    // the message inline while keeping the prompt up.
    const createPage = vi
      .fn()
      .mockRejectedValueOnce(new ArchivedNameConflictError(conflict))
      .mockRejectedValueOnce(new Error('Server unavailable (500)'))
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

    ;(document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement).value = 'old-products'
    document.querySelector('[data-testid="create-redirect-from-input"]')!.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement).value =
      'products/featured'
    document.querySelector('[data-testid="create-redirect-to-input"]')!.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;(document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    // Morph happened — conflict prompt is visible.
    expect(document.querySelector('[data-testid="archived-name-conflict-prompt"]')).not.toBeNull()

    // Operator picks Restore; the re-issued POST rejects with a non-
    // archived error. The error must surface and the prompt must stay.
    ;(document.querySelector('[data-testid="conflict-continue-restore"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(createPage).toHaveBeenCalledTimes(2)

    const errorEl = document.querySelector('[data-testid="create-redirect-error"]')
    expect(errorEl, 'inline error must be rendered after a conflict-resolution failure').not.toBeNull()
    expect(errorEl?.textContent ?? '').toContain('Server unavailable')

    // Author can still pick a different resolution.
    expect(document.querySelector('[data-testid="archived-name-conflict-prompt"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('on 409 ALIAS_TARGET_NOT_FOUND shows inline error', async () => {
    seedSite()
    const createPage = vi.fn().mockRejectedValue(new Error('The page "ghost" does not exist as live content.'))
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

    ;(document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement).value = 'old-products'
    document.querySelector('[data-testid="create-redirect-from-input"]')!.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement).value = 'ghost'
    document.querySelector('[data-testid="create-redirect-to-input"]')!.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;(document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(document.body.textContent ?? '').toContain('does not exist')
    wrapper.unmount()
  })

  it('on 400 INVALID with from=home shows server message inline', async () => {
    seedSite()
    const createPage = vi
      .fn()
      .mockRejectedValue(new Error('Redirect from "home" is not supported in v1 — that route is the site root.'))
    const api = makeRedirectsApi({ createPageRedirect: createPage })
    const wrapper = mountDialog(api)
    await flushPromises()

    ;(document.querySelector('[data-testid="create-redirect-from-input"]') as HTMLInputElement).value = 'home'
    document.querySelector('[data-testid="create-redirect-from-input"]')!.dispatchEvent(new Event('input'))
    ;(document.querySelector('[data-testid="create-redirect-to-input"]') as HTMLInputElement).value = 'welcome'
    document.querySelector('[data-testid="create-redirect-to-input"]')!.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;(document.querySelector('[data-testid="create-redirect-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(document.body.textContent ?? '').toContain('not supported in v1')
    wrapper.unmount()
  })

  it('Esc key closes the dialog', async () => {
    seedSite()
    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('cancel button emits close', async () => {
    seedSite()
    const wrapper = mountDialog(makeRedirectsApi())
    await flushPromises()

    const cancel = document.querySelector('[data-testid="create-redirect-cancel"]') as HTMLButtonElement
    cancel.click()
    await flushPromises()

    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })
})
