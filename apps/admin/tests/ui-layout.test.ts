/**
 * ui/Splitter and ui/Menu — the contract cut 2's import swap relies on
 * (design-admin-ui.md, "The components"): the splitter inserts a keyboard
 * handle between panels that stops at each panel's `minSize`; the menu
 * renders `items` as labelled groups, runs `command` on select and marks the
 * `class: 'active'` item.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import Menu, { type MenuItem } from '../src/client/components/ui/Menu.vue'
import Splitter from '../src/client/components/ui/Splitter.vue'
import SplitterPanel from '../src/client/components/ui/SplitterPanel.vue'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

describe('ui/Splitter', () => {
  async function mountSplitter() {
    wrapper = mount(
      defineComponent(
        () => () =>
          h(Splitter, { class: 'cms-splitter' }, () => [
            h(SplitterPanel, { size: 35, minSize: 25 }, () => 'Components'),
            h(SplitterPanel, { size: 65, minSize: 35 }, () => 'Editor'),
          ]),
      ),
      { attachTo: document.body },
    )
    await flushPromises()
    const handles = wrapper.findAll('[role="separator"]')
    expect(handles).toHaveLength(1)
    return handles[0]!.element as HTMLElement
  }

  async function press(handle: HTMLElement, key: string, times = 1) {
    for (let i = 0; i < times; i++) {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await flushPromises()
    }
  }

  it('puts one named handle between the panels, starting at the first panel size', async () => {
    const handle = await mountSplitter()
    expect(wrapper!.classes()).toContain('cms-splitter')
    expect(handle.getAttribute('aria-label')).toBe('Resize panels')
    expect(handle.getAttribute('aria-valuenow')).toBe('35')
    expect(handle.getAttribute('aria-valuemin')).toBe('25')
    expect(handle.getAttribute('aria-valuemax')).toBe('65')
  })

  it('resizes with the arrow keys and stops at each panel minSize', async () => {
    const handle = await mountSplitter()
    await press(handle, 'ArrowLeft')
    expect(handle.getAttribute('aria-valuenow')).toBe('30')
    await press(handle, 'ArrowLeft', 5)
    expect(handle.getAttribute('aria-valuenow')).toBe('25')
    await press(handle, 'ArrowRight', 12)
    expect(handle.getAttribute('aria-valuenow')).toBe('65')
  })
})

describe('ui/Menu', () => {
  const switchTo = vi.fn()
  const model: MenuItem[] = [
    { label: 'local', class: 'active', command: () => switchTo('local') },
    {
      label: 'production',
      items: [
        { label: 'prod-eu', command: () => switchTo('prod-eu') },
        { label: 'prod-us', command: () => switchTo('prod-us') },
      ],
    },
    { separator: true },
    { label: 'View history', command: () => switchTo('history') },
  ]

  async function openMenu() {
    const menu = ref<InstanceType<typeof Menu> | null>(null)
    wrapper = mount(
      defineComponent(() => () => [
        h('button', { id: 'opener', onClick: (e: Event) => menu.value?.toggle(e) }, 'local'),
        h(Menu, { ref: menu, model, 'data-testid': 'active-target-menu' }),
      ]),
      { attachTo: document.body },
    )
    ;(document.getElementById('opener') as HTMLElement).click()
    await flushPromises()
    const content = document.querySelector<HTMLElement>('[data-testid="active-target-menu"]')
    if (!content) throw new Error('menu not rendered')
    return content
  }

  const item = (content: HTMLElement, label: string) =>
    [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === label)!

  it('renders items with children as a labelled group, and a separator', async () => {
    const content = await openMenu()
    expect(content.getAttribute('role')).toBe('menu')
    const groups = content.querySelectorAll('[role="group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.textContent).toContain('production')
    expect(groups[0]!.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
    expect(content.querySelectorAll('[role="separator"]')).toHaveLength(1)
  })

  it('marks only the active item', async () => {
    const content = await openMenu()
    expect(item(content, 'local').getAttribute('aria-current')).toBe('true')
    expect(item(content, 'prod-eu').hasAttribute('aria-current')).toBe(false)
  })

  it('runs command on select, including inside a group', async () => {
    switchTo.mockClear()
    const content = await openMenu()
    item(content, 'prod-us').click()
    await flushPromises()
    expect(switchTo).toHaveBeenCalledWith('prod-us')
  })
})
