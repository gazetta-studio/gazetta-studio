/**
 * Listbox: options and a selection (design-admin-ui.md, "The components"), as
 * the create dialogs' template list. Runs in light and dark with axe as a hard
 * gate (ADR-0016).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ref } from 'vue'
import Listbox from './Listbox.vue'

const templates = [{ name: 'hero' }, { name: 'text-block' }, { name: 'card-grid' }, { name: 'footer' }]

const meta: Meta<typeof Listbox> = {
  title: 'UI / Listbox',
  component: Listbox,
}

export default meta
type Story = StoryObj<typeof Listbox>

const story = (initial: string | null) => ({
  components: { Listbox },
  setup: () => ({ selected: ref(initial), templates }),
  template: `
    <div style="inline-size: 18rem">
      <Listbox v-model="selected" :options="templates" optionLabel="name" optionValue="name"
        aria-label="Template" data-testid="template-list" :style="{ maxHeight: '200px' }" />
      <p data-testid="selected">{{ selected ?? 'none' }}</p>
    </div>`,
})

export const Options: Story = {
  render: () => story(null),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('option', { name: 'card-grid' }))
    await expect(canvas.getByTestId('selected')).toHaveTextContent('card-grid')
  },
}

export const Selected: Story = {
  render: () => story('text-block'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('option', { name: 'text-block' })).toHaveAttribute('aria-selected', 'true')
  },
}

/** Arrow keys, End and Home move the highlight; Enter selects. */
export const Keyboard: Story = {
  render: () => story('hero'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.tab()
    await expect(canvas.getByRole('option', { name: 'hero' })).toHaveAttribute('data-highlighted')
    await userEvent.keyboard('{ArrowDown}')
    await expect(canvas.getByRole('option', { name: 'text-block' })).toHaveAttribute('data-highlighted')
    await userEvent.keyboard('{End}')
    await expect(canvas.getByRole('option', { name: 'footer' })).toHaveAttribute('data-highlighted')
    await userEvent.keyboard('{Home}')
    await expect(canvas.getByRole('option', { name: 'hero' })).toHaveAttribute('data-highlighted')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expect(canvas.getByTestId('selected')).toHaveTextContent('text-block')
  },
}
