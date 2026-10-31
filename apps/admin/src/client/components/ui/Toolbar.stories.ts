/**
 * Toolbar: start, center and end groups, as CmsToolbar.vue uses them
 * (design-admin-ui.md, "The components").
 */
import { ArrowLeft, Moon, Save, UploadCloud } from '@lucide/vue'
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, within } from 'storybook/test'
import Button from './Button.vue'
import Toolbar from './Toolbar.vue'

const meta: Meta<typeof Toolbar> = {
  title: 'UI / Toolbar',
  component: Toolbar,
}

export default meta
type Story = StoryObj<typeof Toolbar>

export const StartCenterEnd: Story = {
  render: () => ({
    components: { Toolbar, Button },
    setup: () => ({ ArrowLeft, Moon, Save, UploadCloud }),
    template: `
      <Toolbar class="story-toolbar" aria-label="Editor">
        <template #start>
          <Button :icon="ArrowLeft" text rounded size="small" severity="secondary" aria-label="Back to browse" />
          <strong>Gazetta</strong>
          <span>My site</span>
        </template>
        <template #center>
          <span>Saved</span>
        </template>
        <template #end>
          <Button :icon="Moon" text rounded size="small" severity="secondary" aria-label="Switch to dark mode" />
          <Button label="Save" :icon="Save" size="small" />
          <Button label="Publish" :icon="UploadCloud" size="small" severity="success" />
        </template>
      </Toolbar>`,
  }),
  play: async ({ canvasElement }) => {
    const toolbar = within(canvasElement).getByRole('toolbar', { name: 'Editor' })
    await expect(toolbar).toHaveClass('story-toolbar')
    await expect(within(toolbar).getByRole('button', { name: 'Publish' })).toBeInTheDocument()
  },
}

/** Only the end group filled, as on a page without a site name or status. */
export const EndOnly: Story = {
  render: () => ({
    components: { Toolbar, Button },
    setup: () => ({ Save }),
    template: `
      <Toolbar>
        <template #end><Button label="Save" :icon="Save" size="small" /></template>
      </Toolbar>`,
  }),
}
