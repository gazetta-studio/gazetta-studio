/**
 * TextInput: the default and small sizes the admin uses (design-admin-ui.md,
 * "The components"), each with a label as at the call sites.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, within } from 'storybook/test'
import { ref } from 'vue'
import TextInput from './TextInput.vue'

const meta: Meta<typeof TextInput> = {
  title: 'UI / TextInput',
  component: TextInput,
}

export default meta
type Story = StoryObj<typeof TextInput>

function labelled(size?: 'small', initial = '') {
  return () => ({
    components: { TextInput },
    setup: () => ({ value: ref(initial), size }),
    template: `
      <label style="display: grid; gap: 0.25rem; max-inline-size: 20rem">
        <span>Page name</span>
        <TextInput v-model="value" :size="size" placeholder="e.g. contact or blog/my-post" data-testid="name" />
      </label>`,
  })
}

export const Default: Story = {
  render: labelled(),
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox', { name: 'Page name' })
    await userEvent.type(input, 'about')
    await expect(input).toHaveValue('about')
  },
}

export const Small: Story = { render: labelled('small', 'alice@example.com') }
