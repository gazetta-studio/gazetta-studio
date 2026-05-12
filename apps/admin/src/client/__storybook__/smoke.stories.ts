/**
 * Smoke story — proves the Storybook wiring boots and the Aura theme
 * tokens resolve in both light and dark modes. Renders a PrimeVue Button
 * with no admin component dependency, so a regression here means the
 * Storybook setup itself is broken (preview.ts decorators, plugin
 * registration, theme decorator), not an admin component.
 *
 * Real component stories live next to their `.vue` source — see
 * STORYBOOK.md for the convention.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import Button from 'primevue/button'

const meta: Meta<typeof Button> = {
  title: 'Smoke/PrimeVue Button',
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
  args: { label: 'Delete', severity: 'danger', icon: 'pi pi-trash' },
}
