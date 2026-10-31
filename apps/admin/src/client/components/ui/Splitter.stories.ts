/**
 * Splitter + SplitterPanel: horizontal, 35/65 with minimums 25/35, as
 * EditorView.vue sets them (design-admin-ui.md, "The components").
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import Splitter from './Splitter.vue'
import SplitterPanel from './SplitterPanel.vue'

const meta: Meta<typeof Splitter> = {
  title: 'UI / Splitter',
  component: Splitter,
}

export default meta
type Story = StoryObj<typeof Splitter>

const firstPanelShare = (canvas: HTMLElement) => {
  const [first, second] = canvas.querySelectorAll<HTMLElement>('.ui-splitter-panel')
  const a = first.getBoundingClientRect().width
  const b = second.getBoundingClientRect().width
  return (a / (a + b)) * 100
}

export const Horizontal: Story = {
  render: () => ({
    components: { Splitter, SplitterPanel },
    template: `
      <div style="inline-size: 600px; block-size: 200px; border: 1px solid var(--color-border)">
        <Splitter class="story-splitter">
          <SplitterPanel :size="35" :minSize="25"><p style="padding: 1rem">Components</p></SplitterPanel>
          <SplitterPanel :size="65" :minSize="35"><p style="padding: 1rem">Editor</p></SplitterPanel>
        </Splitter>
      </div>`,
  }),
  play: async ({ canvasElement }) => {
    const handle = within(canvasElement).getByRole('separator', { name: 'Resize panels' })
    await expect(handle).toHaveAttribute('aria-valuemin', '25')
    await expect(handle).toHaveAttribute('aria-valuemax', '65')
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '35'))
    await expect(firstPanelShare(canvasElement)).toBeCloseTo(35, 0)

    handle.focus()
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '30'))
    // Further presses stop at the first panel's minimum.
    for (let i = 0; i < 5; i++) await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '25'))
    await expect(firstPanelShare(canvasElement)).toBeCloseTo(25, 0)

    // And at the second panel's minimum the other way.
    for (let i = 0; i < 12; i++) await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '65'))
    await expect(firstPanelShare(canvasElement)).toBeCloseTo(65, 0)
  },
}
