/**
 * RadioGroup with RadioGroupItems named by their labels, both wrapping
 * (`ArchivedNameConflictPrompt.vue`) and `<label for>`. Runs in light and dark
 * with axe as a hard gate (ADR-0016).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { ref } from 'vue'
import RadioGroup from './RadioGroup.vue'
import RadioGroupItem from './RadioGroupItem.vue'

const meta: Meta<typeof RadioGroup> = {
  title: 'UI / RadioGroup',
  component: RadioGroup,
}

export default meta
type Story = StoryObj<typeof RadioGroup>

export const Default: Story = {
  render: () => ({
    components: { RadioGroup, RadioGroupItem },
    setup: () => ({ choice: ref('restore') }),
    template: `
      <RadioGroup v-model="choice" aria-label="Archived name conflict"
        style="display: grid; gap: 0.5rem">
        <label style="display: flex; align-items: center; gap: 0.5rem">
          <RadioGroupItem inputId="conflict-restore" value="restore" />
          <span>Restore the archive</span>
        </label>
        <label style="display: flex; align-items: center; gap: 0.5rem">
          <RadioGroupItem inputId="conflict-replace" value="replace" />
          <span>Replace</span>
        </label>
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <RadioGroupItem inputId="conflict-moveAside" value="moveAside" />
          <label for="conflict-moveAside">Move aside</label>
        </div>
      </RadioGroup>
      <p data-testid="choice">{{ choice }}</p>`,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const restore = canvas.getByRole('radio', { name: 'Restore the archive' })
    await expect(restore).toHaveAttribute('aria-checked', 'true')

    restore.focus()
    // Reka checks the focused radio a tick after the arrow keydown, if the key is
    // still down, so hold it as a person does.
    await userEvent.keyboard('{ArrowDown>}')
    await expect(canvas.getByRole('radio', { name: 'Replace' })).toHaveFocus()
    await waitFor(() => expect(canvas.getByTestId('choice')).toHaveTextContent('replace'))
    await userEvent.keyboard('{/ArrowDown}')

    await userEvent.click(canvas.getByText('Move aside'))
    await expect(canvas.getByRole('radio', { name: 'Move aside' })).toHaveAttribute('aria-checked', 'true')
    await expect(canvas.getByTestId('choice')).toHaveTextContent('moveAside')
  },
}

export const Disabled: Story = {
  render: () => ({
    components: { RadioGroup, RadioGroupItem },
    template: `
      <RadioGroup modelValue="page" disabled aria-label="Redirect kind" style="display: flex; gap: 1rem">
        <label style="display: flex; align-items: center; gap: 0.5rem">
          <RadioGroupItem inputId="kind-page" value="page" /><span>Page</span>
        </label>
        <label style="display: flex; align-items: center; gap: 0.5rem">
          <RadioGroupItem inputId="kind-fragment" value="fragment" /><span>Fragment</span>
        </label>
      </RadioGroup>`,
  }),
}
