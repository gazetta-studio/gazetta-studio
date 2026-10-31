/**
 * Checkbox: unchecked, checked and indeterminate (design-admin-ui.md, "The
 * components"), each named by an external `<label for>` as the publish panel
 * does. Runs in light and dark with axe as a hard gate (ADR-0016).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ref } from 'vue'
import Checkbox from './Checkbox.vue'

const meta: Meta<typeof Checkbox> = {
  title: 'UI / Checkbox',
  component: Checkbox,
}

export default meta
type Story = StoryObj<typeof Checkbox>

const labelled = (initial: boolean, indeterminate = false) => ({
  components: { Checkbox },
  setup: () => ({ value: ref(initial), indeterminate: ref(indeterminate) }),
  template: `
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <Checkbox v-model="value" :indeterminate="indeterminate" :binary="true" inputId="cb"
        data-testid="cb" @update:modelValue="indeterminate = false" />
      <label for="cb">staging</label>
    </div>`,
})

export const Unchecked: Story = {
  render: () => labelled(false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const box = canvas.getByRole('checkbox', { name: 'staging' })
    await expect(box).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(canvas.getByText('staging'))
    await expect(box).toHaveAttribute('aria-checked', 'true')
  },
}

export const Checked: Story = {
  render: () => labelled(true),
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByRole('checkbox', { name: 'staging' })
    await expect(box).toHaveAttribute('aria-checked', 'true')
    box.focus()
    await userEvent.keyboard(' ')
    await expect(box).toHaveAttribute('aria-checked', 'false')
  },
}

/** A group header with some of its targets selected (`PublishPanel.vue`). */
export const Indeterminate: Story = {
  render: () => labelled(false, true),
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByRole('checkbox', { name: 'staging' })
    await expect(box).toHaveAttribute('aria-checked', 'mixed')
    await userEvent.click(box)
    await expect(box).toHaveAttribute('aria-checked', 'true')
  },
}

/** Wrapped in its label, as the publish audit's "Ignore once" is. */
export const WrappedInLabel: Story = {
  render: () => ({
    components: { Checkbox },
    setup: () => ({ value: ref(false) }),
    template: `
      <label style="display: inline-flex; align-items: center; gap: 0.5rem">
        <Checkbox v-model="value" :binary="true" inputId="ignore-1" />
        <span>Ignore once</span>
      </label>`,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText('Ignore once'))
    await expect(canvas.getByRole('checkbox', { name: 'Ignore once' })).toHaveAttribute('aria-checked', 'true')
  },
}

export const Disabled: Story = {
  render: () => ({
    components: { Checkbox },
    template: `
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <Checkbox :modelValue="true" :binary="true" inputId="cb-off" disabled />
        <label for="cb-off">production</label>
      </div>`,
  }),
}
