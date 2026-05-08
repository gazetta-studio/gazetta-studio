/**
 * Component tests for TemplateImpactPanel.vue (Validation Cut 6).
 *
 * The panel renders the impact view for one template — fetches via
 * the TemplatesApi, projects per-item severity icons, navigates to
 * the editor on click. Migrate-as-AI-task is reserved per the
 * footer note; today the row's primary action is "Edit".
 */
import { describe, expect, it, beforeEach, beforeAll, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import PrimeVue from 'primevue/config'
import TemplateImpactPanel from '../src/client/components/TemplateImpactPanel.vue'
import { TEMPLATES_API, type TemplatesApi } from '../src/client/composables/api.js'
import type { TemplateImpactResponse } from '../src/client/api/client.js'

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (q: string) =>
      ({
        matches: false,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
})

function fakeTemplatesApi(impact: TemplateImpactResponse): TemplatesApi {
  return {
    getTemplates: () => Promise.reject(new Error('not stubbed')),
    getTemplateSchema: () => Promise.reject(new Error('not stubbed')),
    getTemplateImpact: () => Promise.resolve(impact),
    getFields: () => Promise.reject(new Error('not stubbed')),
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/pages/:name', component: { template: '<div />' }, name: 'page' },
      { path: '/fragments/:name', component: { template: '<div />' }, name: 'fragment' },
    ],
  })
}

async function mountPanel(impact: TemplateImpactResponse) {
  const router = makeRouter()
  await router.push('/')
  const wrapper = mount(TemplateImpactPanel, {
    props: { template: impact.template },
    global: {
      plugins: [PrimeVue, router],
      provide: { [TEMPLATES_API as symbol]: fakeTemplatesApi(impact) },
    },
  })
  // Settle the onMounted fetch + initial render.
  await new Promise(r => setTimeout(r, 0))
  await wrapper.vm.$nextTick()
  return { wrapper, router }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('TemplateImpactPanel', () => {
  it('renders an empty state when no items use the template', async () => {
    const { wrapper } = await mountPanel({
      template: 'unused',
      items: [],
      affectedItemCount: 0,
    })
    expect(wrapper.find('[data-testid="template-impact-empty"]').exists()).toBe(true)
  })

  it('lists items and reports the summary', async () => {
    const { wrapper } = await mountPanel({
      template: 'hero',
      items: [
        { kind: 'page', name: 'home', itemPath: 'pages/home/page.json', issues: [] },
        { kind: 'fragment', name: 'header', itemPath: 'fragments/header/fragment.json', issues: [] },
      ],
      affectedItemCount: 0,
    })
    const summary = wrapper.find('[data-testid="template-impact-summary"]')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('2')
    expect(summary.text()).toContain('hero')
    expect(summary.text()).toContain('all clean')
    expect(wrapper.find('[data-testid="template-impact-row-page-home"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="template-impact-row-fragment-header"]').exists()).toBe(true)
  })

  it('renders severity per row + counts affected items in the summary', async () => {
    const { wrapper } = await mountPanel({
      template: 'hero',
      items: [
        {
          kind: 'page',
          name: 'home',
          itemPath: 'pages/home/page.json',
          issues: [
            {
              validator: 'schema-conformance',
              severity: 'error',
              message: 'title: Required',
              itemPath: 'pages/home/page.json',
            },
          ],
        },
        {
          kind: 'page',
          name: 'about',
          itemPath: 'pages/about/page.json',
          issues: [
            {
              validator: 'schema-conformance',
              severity: 'warn',
              message: 'subtitle: deprecated',
              itemPath: 'pages/about/page.json',
            },
          ],
        },
        { kind: 'page', name: 'blog', itemPath: 'pages/blog/page.json', issues: [] },
      ],
      affectedItemCount: 2,
    })
    expect(wrapper.find('[data-testid="template-impact-summary"]').text()).toContain('2')
    expect(wrapper.find('[data-testid="template-impact-summary"]').text()).toContain('with issues')
    // Each row carries severity-{level} class so the icon color reflects worst severity.
    expect(wrapper.find('[data-testid="template-impact-row-page-home"]').classes()).toContain('severity-error')
    expect(wrapper.find('[data-testid="template-impact-row-page-about"]').classes()).toContain('severity-warn')
    expect(wrapper.find('[data-testid="template-impact-row-page-blog"]').classes()).toContain('severity-clean')
  })

  it('clicking Edit on a page navigates to /pages/{name}', async () => {
    const { wrapper, router } = await mountPanel({
      template: 'hero',
      items: [{ kind: 'page', name: 'home', itemPath: 'pages/home/page.json', issues: [] }],
      affectedItemCount: 0,
    })
    await wrapper.find('[data-testid="template-impact-edit-page-home"]').trigger('click')
    await router.isReady()
    await new Promise(r => setTimeout(r, 0))
    expect(router.currentRoute.value.path).toBe('/pages/home')
  })

  it('clicking Edit on a fragment navigates to /fragments/{name}', async () => {
    const { wrapper, router } = await mountPanel({
      template: 'header-layout',
      items: [{ kind: 'fragment', name: 'header', itemPath: 'fragments/header/fragment.json', issues: [] }],
      affectedItemCount: 0,
    })
    await wrapper.find('[data-testid="template-impact-edit-fragment-header"]').trigger('click')
    await router.isReady()
    await new Promise(r => setTimeout(r, 0))
    expect(router.currentRoute.value.path).toBe('/fragments/header')
  })

  it('mentions the future Migrate-with-AI direction in the footer', async () => {
    const { wrapper } = await mountPanel({
      template: 'hero',
      items: [{ kind: 'page', name: 'home', itemPath: 'pages/home/page.json', issues: [] }],
      affectedItemCount: 0,
    })
    expect(wrapper.text()).toMatch(/Migrate with AI/i)
  })
})
