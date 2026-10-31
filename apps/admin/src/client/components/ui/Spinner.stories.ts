/**
 * Spinner: the single 1.5rem size the admin uses, with its default and a
 * custom accessible label (design-admin-ui.md, "The components").
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, within } from 'storybook/test'
import Spinner from './Spinner.vue'

const meta: Meta<typeof Spinner> = {
  title: 'UI / Spinner',
  component: Spinner,
}

export default meta
type Story = StoryObj<typeof Spinner>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
  },
}

export const CustomLabel: Story = {
  render: () => ({
    components: { Spinner },
    template: '<Spinner aria-label="Loading history" />',
  }),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading history' })).toBeInTheDocument()
  },
}
