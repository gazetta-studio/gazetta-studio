/**
 * Component tests for ConflictBanner.vue.
 *
 *   - Hidden when active item has no conflict
 *   - Renders headline + body + two action buttons when conflict exists
 *   - "Show what changed" toggles the diff view
 *   - "Discard my changes" clears the conflict + emits `discard`
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConflictBanner from '../src/client/components/ConflictBanner.vue'
import { useSaveConflictsStore } from '../src/client/stores/saveConflicts.js'

const ITEM_PATH = 'pages/home/page.json'
const SAMPLE_CONFLICT = {
  itemPath: ITEM_PATH,
  current: { template: 'page-default', content: { title: 'Theirs' }, components: [] },
  currentEtag: 'fresh',
  pending: { template: 'page-default', content: { title: 'Mine' }, components: [] },
}

function mountBanner(itemPath = ITEM_PATH) {
  return mount(ConflictBanner, {
    props: { itemPath },
    global: { plugins: [PrimeVue] },
  })
}

describe('ConflictBanner', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders nothing when no conflict for the active path', () => {
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="conflict-banner"]').exists()).toBe(false)
  })

  it('renders the banner when a conflict exists for the active path', () => {
    const conflicts = useSaveConflictsStore()
    conflicts.set(SAMPLE_CONFLICT)
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="conflict-banner"]').exists()).toBe(true)
    // Plain-language copy per Krug-aligned UX.
    expect(wrapper.text()).toContain('Was edited by someone else')
  })

  it('does not render for a different itemPath', () => {
    const conflicts = useSaveConflictsStore()
    conflicts.set(SAMPLE_CONFLICT)
    const wrapper = mountBanner('pages/about/page.json')
    expect(wrapper.find('[data-testid="conflict-banner"]').exists()).toBe(false)
  })

  it('"Show what changed" button reveals the diff view; "X" closes it', async () => {
    const conflicts = useSaveConflictsStore()
    conflicts.set(SAMPLE_CONFLICT)
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="conflict-diff-view"]').exists()).toBe(false)

    await wrapper.find('[data-testid="conflict-banner-show-diff"]').trigger('click')
    expect(wrapper.find('[data-testid="conflict-diff-view"]').exists()).toBe(true)

    await wrapper.find('[data-testid="conflict-diff-close"]').trigger('click')
    expect(wrapper.find('[data-testid="conflict-diff-view"]').exists()).toBe(false)
  })

  it('"Discard my changes" clears the conflict and emits `discard`', async () => {
    const conflicts = useSaveConflictsStore()
    conflicts.set(SAMPLE_CONFLICT)
    const wrapper = mountBanner()

    await wrapper.find('[data-testid="conflict-banner-discard"]').trigger('click')

    expect(conflicts.has(ITEM_PATH)).toBe(false)
    expect(wrapper.emitted('discard')).toHaveLength(1)
    // Banner closes once the conflict clears.
    expect(wrapper.find('[data-testid="conflict-banner"]').exists()).toBe(false)
  })

  it('does NOT include a "Save anyway / Overwrite" action (Krug lock)', () => {
    // Pin the design-offline.md Q3 lock: there's no overwrite button.
    // Authors who genuinely want to overwrite manually port their
    // edits onto the new version.
    const conflicts = useSaveConflictsStore()
    conflicts.set(SAMPLE_CONFLICT)
    const wrapper = mountBanner()

    const buttonText = wrapper.findAll('button').map(b => b.text().toLowerCase())
    expect(buttonText.some(t => t.includes('overwrite'))).toBe(false)
    expect(buttonText.some(t => t.includes('save anyway'))).toBe(false)
  })
})
