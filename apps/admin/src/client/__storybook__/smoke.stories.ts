/**
 * Smoke story — proves the Storybook wiring boots and the admin tokens
 * resolve in both light and dark modes. Renders a ui/Button with no admin
 * screen dependency, so a regression here means the Storybook setup itself
 * is broken (preview.ts decorators, plugin registration, theme decorator),
 * not an admin component.
 *
 * Real component stories live next to their `.vue` source — see
 * STORYBOOK.md for the convention.
 */
import { Trash2 } from '@lucide/vue'
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import Button from '../components/ui/Button.vue'

const meta: Meta<typeof Button> = {
  title: 'Smoke/Button',
  component: Button,
}

export default meta

type Story = StoryObj<typeof Button>

export const Primary: Story = {
  args: { label: 'Primary', severity: 'primary' },
}

export const Secondary: Story = {
  args: { label: 'Secondary', severity: 'secondary' },
}

export const Danger: Story = {
  args: { label: 'Delete', severity: 'danger', icon: Trash2 },
}
