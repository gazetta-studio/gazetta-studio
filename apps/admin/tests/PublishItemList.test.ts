/**
 * Component tests for PublishItemList.vue — the item selection the
 * Publish panel sends as `items`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PublishItemList from '../src/client/components/PublishItemList.vue'
import { api } from '../src/client/api/client.js'

function lastSelection(w: ReturnType<typeof mount>): Set<string> {
  const events = w.emitted('update:selected') as Set<string>[][] | undefined
  expect(events?.length).toBeGreaterThan(0)
  return events![events!.length - 1][0]
}

describe('PublishItemList', () => {
  afterEach(() => vi.restoreAllMocks())

  async function mountWithTargetOnlyRow() {
    vi.spyOn(api, 'compare').mockResolvedValue({
      added: ['pages/new'],
      modified: ['pages/home'],
      deleted: ['pages/old-launch'],
      unchanged: [],
      firstPublish: false,
      invalidTemplates: [],
    })
    const w = mount(PublishItemList, {
      props: { source: 'local', destinations: ['staging'], selected: new Set<string>() },
    })
    await flushPromises()
    return w
  }

  it('leaves target-only rows out of the default selection', async () => {
    const w = await mountWithTargetOnlyRow()
    expect(w.find('[data-testid="publish-item-pages/old-launch"]').exists()).toBe(true)
    expect([...lastSelection(w)].sort()).toEqual(['pages/home', 'pages/new'])
  })

  it('leaves target-only rows out of "Select all"', async () => {
    const w = await mountWithTargetOnlyRow()
    await w.setProps({ selected: new Set<string>() })
    await w.find('[data-testid="publish-select-all"]').trigger('click')
    expect([...lastSelection(w)].sort()).toEqual(['pages/home', 'pages/new'])
  })
})
