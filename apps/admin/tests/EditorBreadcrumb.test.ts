/**
 * Tests for EditorBreadcrumb.vue (#82).
 *
 * Drive the breadcrumb's two inputs:
 *   - selection store (page or fragment + name)
 *   - editing store's path (`_root` | name path | `@fragmentName`)
 *
 * Verify the rendered segments + the click-navigation hashes. The
 * router beforeEach guard for unsaved edits is exercised via the
 * existing UnsavedDialog test suite — this file pins the breadcrumb's
 * own contract.
 */
import { beforeEach, describe, expect, it, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import PrimeVue from 'primevue/config'
import EditorBreadcrumb from '../src/client/components/EditorBreadcrumb.vue'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import type { EditingTarget } from '../src/client/stores/editorContent.js'
import type { PageDetail, FragmentDetail } from '../src/client/api/client.js'

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

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/pages/:name/edit', component: { template: '<div />' }, name: 'page-edit' },
      { path: '/fragments/:name/edit', component: { template: '<div />' }, name: 'fragment-edit' },
    ],
  })
}

/**
 * Mount the breadcrumb with the stores in a known state. `editingPath`
 * sets `editorContent.target.path` (the breadcrumb's primary input);
 * setSelection() seeds the selection store.
 */
async function mountAt(opts: {
  selection: 'page' | 'fragment'
  selectionName: string
  editingPath: string | null
  startUrl?: string
}) {
  const router = makeRouter()
  await router.push(opts.startUrl ?? `/${opts.selection === 'page' ? 'pages' : 'fragments'}/${opts.selectionName}/edit`)

  const sel = useSelectionStore()
  if (opts.selection === 'page') {
    sel.selection = {
      type: 'page',
      name: opts.selectionName,
      detail: {
        name: opts.selectionName,
        route: '/',
        template: 'page-default',
        dir: `pages/${opts.selectionName}`,
        components: [],
      } as PageDetail,
    }
  } else {
    sel.selection = {
      type: 'fragment',
      name: opts.selectionName,
      detail: {
        name: opts.selectionName,
        template: 'header-layout',
        dir: `fragments/${opts.selectionName}`,
      } as FragmentDetail,
    }
  }

  const ec = useEditorContentStore()
  if (opts.editingPath !== null) {
    ec.target = {
      template: 'x',
      path: opts.editingPath,
      content: {},
      schema: {},
      save: async () => {},
    } as EditingTarget
  }

  const w = mount(EditorBreadcrumb, {
    global: { plugins: [PrimeVue, router] },
  })
  await w.vm.$nextTick()
  return { wrapper: w, router }
}

describe('EditorBreadcrumb — page context', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows just the page name when at root', async () => {
    const { wrapper } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: '_root',
    })
    const segments = wrapper.findAll('[data-testid^="breadcrumb-segment-"]')
    expect(segments).toHaveLength(1)
    expect(segments[0].text()).toBe('home')
    // At root, the only segment is the current — non-clickable.
    expect(segments[0].element.tagName).toBe('SPAN')
  })

  it('shows page name > component when editing a top-level component', async () => {
    const { wrapper } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'hero',
    })
    const segments = wrapper.findAll('[data-testid^="breadcrumb-segment-"]')
    expect(segments).toHaveLength(2)
    expect(segments[0].text()).toBe('home')
    expect(segments[1].text()).toBe('hero')
    // Page name is clickable (not at root); component is current.
    expect(segments[0].element.tagName).toBe('BUTTON')
    expect(segments[1].element.tagName).toBe('SPAN')
  })

  it('shows full nested path for inline composite children', async () => {
    const { wrapper } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'features/fast',
    })
    const segments = wrapper.findAll('[data-testid^="breadcrumb-segment-"]')
    expect(segments).toHaveLength(3)
    expect(segments.map(s => s.text())).toEqual(['home', 'features', 'fast'])
    // home + features clickable; fast is current
    expect(segments[0].element.tagName).toBe('BUTTON')
    expect(segments[1].element.tagName).toBe('BUTTON')
    expect(segments[2].element.tagName).toBe('SPAN')
  })

  it('separator is rendered between segments and is hidden from screen readers', async () => {
    const { wrapper } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'features/fast',
    })
    const seps = wrapper.findAll('.separator')
    expect(seps).toHaveLength(2) // 3 segments → 2 separators
    expect(seps[0].attributes('aria-hidden')).toBe('true')
  })

  it('the current segment carries aria-current="location"', async () => {
    const { wrapper } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'hero',
    })
    const current = wrapper.find('.segment-current')
    expect(current.exists()).toBe(true)
    expect(current.attributes('aria-current')).toBe('location')
    expect(current.text()).toBe('hero')
  })
})

describe('EditorBreadcrumb — fragment context', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows @fragmentName when editing the fragment root', async () => {
    const { wrapper } = await mountAt({
      selection: 'fragment',
      selectionName: 'header',
      editingPath: '@header',
    })
    const segments = wrapper.findAll('[data-testid^="breadcrumb-segment-"]')
    expect(segments).toHaveLength(1)
    expect(segments[0].text()).toBe('@header')
    // Editing path === @header is treated as root for the fragment;
    // single segment, non-clickable.
    expect(segments[0].element.tagName).toBe('SPAN')
  })

  it('shows @fragmentName > component when editing a child', async () => {
    const { wrapper } = await mountAt({
      selection: 'fragment',
      selectionName: 'header',
      editingPath: 'nav',
    })
    const segments = wrapper.findAll('[data-testid^="breadcrumb-segment-"]')
    expect(segments).toHaveLength(2)
    expect(segments.map(s => s.text())).toEqual(['@header', 'nav'])
    expect(segments[0].element.tagName).toBe('BUTTON') // root clickable
    expect(segments[1].element.tagName).toBe('SPAN') // current
  })

  it('shows nested fragment children: @header > nav > link-list', async () => {
    const { wrapper } = await mountAt({
      selection: 'fragment',
      selectionName: 'header',
      editingPath: 'nav/link-list',
    })
    const segments = wrapper.findAll('[data-testid^="breadcrumb-segment-"]')
    expect(segments).toHaveLength(3)
    expect(segments.map(s => s.text())).toEqual(['@header', 'nav', 'link-list'])
  })
})

describe('EditorBreadcrumb — navigation on click', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('clicking the page name segment from a component navigates to the page root (empty hash)', async () => {
    const { wrapper, router } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'features/fast',
      startUrl: '/pages/home/edit#features/fast',
    })
    await wrapper.find('[data-testid="breadcrumb-segment-home"]').trigger('click')
    await router.isReady()
    await new Promise(r => setTimeout(r, 0))
    expect(router.currentRoute.value.hash).toBe('')
  })

  it('clicking an intermediate segment navigates to that level', async () => {
    const { wrapper, router } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'features/fast',
      startUrl: '/pages/home/edit#features/fast',
    })
    await wrapper.find('[data-testid="breadcrumb-segment-features"]').trigger('click')
    await router.isReady()
    await new Promise(r => setTimeout(r, 0))
    expect(router.currentRoute.value.hash).toBe('#features')
  })

  it('clicking the current segment is a no-op (it renders as a span, not a button)', async () => {
    const { wrapper, router } = await mountAt({
      selection: 'page',
      selectionName: 'home',
      editingPath: 'hero',
      startUrl: '/pages/home/edit#hero',
    })
    const current = wrapper.find('[data-testid="breadcrumb-segment-hero"]')
    expect(current.element.tagName).toBe('SPAN')
    // The hash should remain unchanged; verify by attempting a click
    // and asserting no navigation. Span has no click handler, so this
    // is mostly a structural assertion — pin it explicitly.
    await current.trigger('click')
    expect(router.currentRoute.value.hash).toBe('#hero')
  })
})

describe('EditorBreadcrumb — empty / edge states', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders nothing when there is no selection', async () => {
    const router = makeRouter()
    await router.push('/')
    const w = mount(EditorBreadcrumb, {
      global: { plugins: [PrimeVue, router] },
    })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="editor-breadcrumb"]').exists()).toBe(false)
  })
})
