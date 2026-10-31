/**
 * Select: placeholder, selected, small, clearable and open (design-admin-ui.md,
 * "The components"), as the audit filters and the publish source picker use
 * it. Runs in light and dark with axe as a hard gate (ADR-0016).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { ref } from 'vue'
import Dialog from './Dialog.vue'
import Select from './Select.vue'

const outcomes = [
  { label: 'Success', value: 'success' },
  { label: 'Failure', value: 'failure' },
  { label: 'Denied', value: 'denied' },
]

const meta: Meta<typeof Select> = {
  title: 'UI / Select',
  component: Select,
}

export default meta
type Story = StoryObj<typeof Select>

const story = (initial: string | null, extra = '') => ({
  components: { Select },
  setup: () => ({ value: ref(initial), outcomes }),
  template: `
    <div>
      <Select v-model="value" :options="outcomes" optionLabel="label" optionValue="value"
        placeholder="All outcomes" aria-label="Outcome" data-testid="outcome" ${extra} />
      <p data-testid="value">{{ value ?? 'none' }}</p>
    </div>`,
})

export const Placeholder: Story = {
  render: () => story(null),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('outcome')).toHaveTextContent('All outcomes')
  },
}

export const Selected: Story = {
  render: () => story('failure'),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('outcome')).toHaveTextContent('Failure')
  },
}

export const Small: Story = { render: () => story('success', 'size="small"') }

/** `showClear`: the clear button emits null and the placeholder returns. */
export const Clearable: Story = {
  render: () => story('denied', 'showClear size="small"'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Clear selection' }))
    await expect(canvas.getByTestId('value')).toHaveTextContent('none')
    await expect(canvas.getByTestId('outcome')).toHaveTextContent('All outcomes')
    await expect(canvas.queryByRole('button', { name: 'Clear selection' })).toBeNull()
  },
}

/** Opened from the keyboard; arrow keys move through the options, Enter picks one. */
export const Open: Story = {
  render: () => story(null),
  // The options are teleported to <body>, outside the story root axe checks by
  // default. While open, Reka hides the rest of the page with aria-hidden (focus
  // stays in the options), so that part is excluded; the closed stories check it.
  parameters: { a11y: { context: { include: 'body', exclude: '[data-aria-hidden]' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    canvas.getByTestId('outcome').focus()
    await userEvent.keyboard('{ArrowDown}')
    const listbox = await body.findByRole('listbox')
    await waitFor(() => expect(body.getByRole('option', { name: 'Success' })).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}')
    await expect(body.getByRole('option', { name: 'Failure' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(listbox).not.toBeInTheDocument())
    await expect(canvas.getByTestId('value')).toHaveTextContent('failure')
    // Reopen so axe checks the open options.
    await userEvent.click(canvas.getByTestId('outcome'))
    await body.findByRole('listbox')
  },
}

/** Inside a Dialog, as in the audit drawer: the options open above the dialog and take a click. */
export const InDialog: Story = {
  render: () => ({
    components: { Select, Dialog },
    setup: () => ({ value: ref(null), outcomes }),
    template: `
      <Dialog :visible="true" header="Audit log" :closable="false">
        <Select v-model="value" :options="outcomes" optionLabel="label" optionValue="value"
          placeholder="All outcomes" aria-label="Outcome" data-testid="outcome" size="small" />
        <p data-testid="value">{{ value ?? 'none' }}</p>
      </Dialog>`,
  }),
  parameters: { a11y: { context: { include: 'body', exclude: '[data-aria-hidden]' } } },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(await body.findByTestId('outcome'))
    const option = await body.findByRole('option', { name: 'Denied' })
    const box = option.getBoundingClientRect()
    const top = canvasElement.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    await expect(option.contains(top)).toBe(true)
    await userEvent.click(option)
    await waitFor(() => expect(body.getByTestId('value')).toHaveTextContent('denied'))
  },
}
