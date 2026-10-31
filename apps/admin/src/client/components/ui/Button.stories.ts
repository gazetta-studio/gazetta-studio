/**
 * Button: every variant and state the admin uses (design-admin-ui.md, "The
 * components"). Runs in light and dark under `npm run test:storybook` with axe
 * as a hard gate (ADR-0016).
 */
import { Check, Save, ShieldCheck, Trash2, X } from '@lucide/vue'
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, within } from 'storybook/test'
import Button from './Button.vue'

const meta: Meta<typeof Button> = {
  title: 'UI / Button',
  component: Button,
  args: { label: 'Save' },
}

export default meta
type Story = StoryObj<typeof Button>

export const Primary: Story = {}

const severities = ['primary', 'secondary', 'danger', 'success', 'warn', 'info'] as const

/** Every severity in each variant: solid, outlined, text and link. */
export const Severities: Story = {
  render: () => ({
    components: { Button },
    setup: () => ({ severities, variants: ['solid', 'outlined', 'text', 'link'] }),
    template: `
      <div style="display: grid; gap: 0.75rem">
        <div v-for="v in variants" :key="v" style="display: flex; gap: 0.5rem; flex-wrap: wrap">
          <Button v-for="s in severities" :key="s" :label="s" :severity="s"
            :outlined="v === 'outlined'" :text="v === 'text'" :link="v === 'link'" />
        </div>
      </div>`,
  }),
}

export const Small: Story = { args: { size: 'small', icon: Save } }

export const WithIcon: Story = { args: { icon: Check } }

export const Rounded: Story = { args: { rounded: true, severity: 'secondary' } }

/** Icon-only: the label goes into aria-label. */
export const IconOnly: Story = {
  render: () => ({
    components: { Button },
    setup: () => ({ X, Trash2 }),
    template: `
      <div style="display: flex; gap: 0.5rem">
        <Button :icon="X" text rounded severity="secondary" size="small" aria-label="Dismiss" />
        <Button :icon="Trash2" text rounded severity="danger" size="small" aria-label="Delete page home" />
      </div>`,
  }),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  },
}

export const Loading: Story = {
  args: { loading: true, label: 'Saving…' },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button')
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('aria-busy', 'true')
  },
}

export const Disabled: Story = { args: { disabled: true } }

/** The site-health button: a count badge whose severity follows the scan. */
export const WithBadge: Story = {
  render: () => ({
    components: { Button },
    setup: () => ({ ShieldCheck }),
    template: `
      <div style="display: flex; gap: 0.5rem">
        <Button :icon="ShieldCheck" text rounded size="small" severity="info" badge="3" aria-label="Site health: 3 issues" />
        <Button :icon="ShieldCheck" text rounded size="small" severity="warn" badge="12" aria-label="Site health: 12 warnings" />
        <Button :icon="ShieldCheck" text rounded size="small" severity="danger" badge="1" aria-label="Site health: 1 error" />
        <Button label="Filters" severity="secondary" badge="2" badge-severity="info" />
      </div>`,
  }),
}
