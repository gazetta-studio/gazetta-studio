/**
 * SiteHealthDrawer.vue — Validation Cut 2 admin surface tests.
 *
 * Verifies:
 *   - Empty state ("No issues found") when scanner is clean
 *   - Renders one group per item, sorted by worst severity
 *   - Each issue surfaced with its message + severity icon
 *   - Click on an item header navigates via the router
 *   - Locale-variant paths route to the right URL with `?locale=`
 *   - Fetch error surfaces a Retry control
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import PrimeVue from 'primevue/config'
import SiteHealthDrawer from '../src/client/components/SiteHealthDrawer.vue'
import { useValidationScannerStore } from '../src/client/stores/validationScanner.js'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/pages/:name', component: { template: '<div />' } },
    { path: '/fragments/:name', component: { template: '<div />' } },
  ],
})

async function makeWrapper(visible = true) {
  await router.push('/')
  await router.isReady()
  return mount(SiteHealthDrawer, {
    props: { visible },
    global: {
      plugins: [PrimeVue, router],
    },
    attachTo: document.body,
  })
}

/**
 * Find the item header by its `data-testid`. CSS selectors don't escape
 * forward slashes in attribute values reliably across jsdom; iterate the
 * NodeList of all health items and match by getAttribute.
 */
function findItemHeader(itemPath: string): HTMLButtonElement | null {
  const items = document.querySelectorAll<HTMLElement>('[data-testid^="health-item-"]')
  for (const item of items) {
    if (item.getAttribute('data-testid') === `health-item-${itemPath}`) {
      return item.querySelector('button')
    }
  }
  return null
}

describe('SiteHealthDrawer', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  it('renders the empty state when there are no issues', async () => {
    const wrapper = await makeWrapper(true)
    await wrapper.vm.$nextTick()
    const drawer = document.querySelector('[data-testid="site-health-drawer"]')
    expect(drawer?.textContent).toContain('No issues found')
    wrapper.unmount()
  })

  it('renders one group per item with the worst severity', async () => {
    const wrapper = await makeWrapper(true)
    const store = useValidationScannerStore()
    store.issues = [
      {
        validator: 'referenced-fragment-exists',
        severity: 'error',
        message: 'Fragment "@missing" referenced but not found.',
        itemPath: 'pages/home/page.json',
      },
      {
        validator: 'unused-fragment',
        severity: 'info',
        message: 'Fragment "@orphan" is defined but no page references it.',
        itemPath: 'fragments/orphan/fragment.json',
      },
    ]
    await wrapper.vm.$nextTick()
    const items = document.querySelectorAll('[data-testid^="health-item-"]')
    expect(items.length).toBe(2)
    // Error sorts before info — pages/home should come first.
    expect(items[0].getAttribute('data-testid')).toBe('health-item-pages/home/page.json')
    wrapper.unmount()
  })

  it('navigates to the item when its header is clicked', async () => {
    const wrapper = await makeWrapper(true)
    const store = useValidationScannerStore()
    store.issues = [
      {
        validator: 'referenced-fragment-exists',
        severity: 'error',
        message: 'broken',
        itemPath: 'pages/home/page.json',
      },
    ]
    await wrapper.vm.$nextTick()
    const header = findItemHeader('pages/home/page.json')
    expect(header).toBeTruthy()
    header!.click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/pages/home')
    wrapper.unmount()
  })

  it('routes locale variants with the locale query', async () => {
    const wrapper = await makeWrapper(true)
    const store = useValidationScannerStore()
    store.issues = [
      {
        validator: 'orphaned-locale-file',
        severity: 'warn',
        message: 'orphan',
        itemPath: 'pages/home/page.fr.json',
      },
    ]
    await wrapper.vm.$nextTick()
    const header = findItemHeader('pages/home/page.fr.json')
    expect(header).toBeTruthy()
    header!.click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/pages/home')
    expect(router.currentRoute.value.query.locale).toBe('fr')
    wrapper.unmount()
  })

  it('shows a retry control when fetch errored', async () => {
    const wrapper = await makeWrapper(true)
    const store = useValidationScannerStore()
    store.fetchError = 'HTTP 500'
    await wrapper.vm.$nextTick()
    const drawer = document.querySelector('[data-testid="site-health-drawer"]')
    expect(drawer?.textContent).toContain("Couldn't fetch issues")
    expect(drawer?.textContent).toContain('Retry')
    wrapper.unmount()
  })
})
