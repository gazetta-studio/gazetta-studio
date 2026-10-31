/**
 * Menu: a popup opened from a separate button, with icons, grouped sections,
 * the active item marked and a separator, as ActiveTargetIndicator.vue uses it
 * (design-admin-ui.md, "The components"). Opened in each play function, so
 * axe checks the open menu.
 */
import { Check, Circle, History, Lock, ShieldCheck } from '@lucide/vue'
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test'
import { ref } from 'vue'
import Button from './Button.vue'
import Menu, { type MenuItem } from './Menu.vue'

const meta: Meta<typeof Menu> = {
  title: 'UI / Menu',
  component: Menu,
}

export default meta
type Story = StoryObj<typeof Menu>

const switchTo = fn()
const viewHistory = fn()

const model: MenuItem[] = [
  { label: 'local', icon: Check, class: 'active', command: () => switchTo('local') },
  {
    label: 'production',
    items: [
      { label: 'prod-eu', icon: Lock, command: () => switchTo('prod-eu') },
      { label: 'prod-us', icon: Lock, command: () => switchTo('prod-us') },
    ],
  },
  { label: 'staging', icon: Circle, command: () => switchTo('staging') },
  { separator: true },
  { label: 'View history', icon: History, command: () => viewHistory() },
  { label: 'View audit log', icon: ShieldCheck },
]

const render = () => ({
  components: { Menu, Button },
  setup: () => {
    const menu = ref<InstanceType<typeof Menu> | null>(null)
    return { menu, model }
  },
  template: `
    <div style="block-size: 360px">
      <Button id="target-button" label="local" severity="secondary" aria-haspopup="menu" @click="menu?.toggle($event)" />
      <Menu ref="menu" :model="model" :popup="true" data-testid="active-target-menu" />
    </div>`,
})

async function open(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'local' }))
  return screen.findByRole('menu')
}

export const Open: Story = {
  render,
  play: async ({ canvasElement }) => {
    const menu = await open(canvasElement)
    await expect(menu).toHaveAttribute('data-testid', 'active-target-menu')
    await expect(within(menu).getByText('production')).toBeInTheDocument()
    await expect(within(menu).getAllByRole('group')).toHaveLength(1)
    await expect(within(menu).getByRole('separator')).toBeInTheDocument()
    const active = within(menu).getByRole('menuitem', { name: 'local' })
    await expect(active).toHaveAttribute('aria-current', 'true')
    await expect(within(menu).getByRole('menuitem', { name: 'staging' })).not.toHaveAttribute('aria-current')
    // Positioned below the button, and styled although teleported to <body>.
    await waitFor(() => expect(menu.getBoundingClientRect().top).toBeGreaterThan(0))
    await expect(getComputedStyle(menu).borderTopLeftRadius).toBe('6px')
    await expect(getComputedStyle(active).fontWeight).toBe('600')
  },
}

export const Keyboard: Story = {
  render,
  play: async ({ canvasElement }) => {
    switchTo.mockClear()
    const button = within(canvasElement).getByRole('button', { name: 'local' })
    let menu = await open(canvasElement)
    // Arrows move through the items (group members included), Enter selects.
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'local' })).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'prod-eu' })).toHaveFocus())
    await userEvent.keyboard('{Enter}')
    await expect(switchTo).toHaveBeenCalledWith('prod-eu')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(button).toHaveFocus())

    // Escape closes and returns focus to the button.
    menu = await open(canvasElement)
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(button).toHaveFocus())

    // A second click on the button closes it.
    menu = await open(canvasElement)
    await userEvent.click(button)
    await waitFor(() => expect(menu).not.toBeInTheDocument())
  },
}

/** Clicking another control closes the menu and leaves focus on that control. */
export const OutsideClick: Story = {
  render: () => ({
    components: { Menu, Button },
    setup: () => {
      const menu = ref<InstanceType<typeof Menu> | null>(null)
      return { menu, model }
    },
    template: `
      <div style="block-size: 360px; display: flex; gap: 1rem; align-items: start">
        <Button label="local" severity="secondary" aria-haspopup="menu" @click="menu?.toggle($event)" />
        <label>Search <input data-testid="search" /></label>
        <Menu ref="menu" :model="model" :popup="true" />
      </div>`,
  }),
  play: async ({ canvasElement }) => {
    const menu = await open(canvasElement)
    const input = within(canvasElement).getByTestId('search')
    await userEvent.click(input)
    await waitFor(() => expect(menu).not.toBeInTheDocument())
    await expect(input).toHaveFocus()
  },
}
