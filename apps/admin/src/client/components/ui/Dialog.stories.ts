/**
 * Dialog: every state the admin uses (design-admin-ui.md, "The components").
 * Each story opens on render so axe checks the open dialog (it's teleported to
 * <body>, which axe scans) in light and dark (ADR-0016).
 */
import { Check } from '@lucide/vue'
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
import { ref } from 'vue'
import Button from './Button.vue'
import Dialog from './Dialog.vue'

const meta: Meta<typeof Dialog> = {
  title: 'UI / Dialog',
  component: Dialog,
}

export default meta
type Story = StoryObj<typeof Dialog>

const dialog = () => screen.findByRole('dialog')
const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

/** Modal with a title, body and footer actions; Escape and the Close button close it. */
export const WithFooter: Story = {
  render: () => ({
    components: { Dialog, Button },
    setup: () => ({ visible: ref(true) }),
    template: `
      <Dialog v-model:visible="visible" modal header="Archive page home" :style="{ width: '32rem' }" data-testid="archive-modal">
        <p style="margin: 0">Visitors will see a “page removed” response instead of this page.</p>
        <template #footer>
          <Button label="Cancel" severity="secondary" text @click="visible = false" />
          <Button label="Archive" severity="danger" />
        </template>
      </Dialog>`,
  }),
  play: async () => {
    const panel = await dialog()
    await expect(panel).toHaveAccessibleName('Archive page home')
    await expect(panel).toHaveAttribute('data-testid', 'archive-modal')
    // Focus lands on the first action in the body or footer, not the header's Close.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await closed()
  },
}

/** Close turned off, as in UnsavedDialog: no Close button, Escape doesn't close, blurred mask. */
export const CloseOff: Story = {
  render: () => ({
    components: { Dialog, Button },
    setup: () => ({ visible: ref(true), Check }),
    template: `
      <Dialog v-model:visible="visible" modal header="Unsaved Changes" :closable="false"
        :style="{ width: '26rem' }" :pt="{ mask: { style: 'backdrop-filter: blur(2px)' } }">
        <p style="margin: 0">You have unsaved changes on <strong>home</strong>.</p>
        <template #footer>
          <Button label="Don't Save" severity="danger" text />
          <Button label="Cancel" severity="secondary" text />
          <Button label="Save" :icon="Check" autofocus />
        </template>
      </Dialog>`,
  }),
  play: async () => {
    const panel = await dialog()
    await expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    // An [autofocus] action wins, as it did with PrimeVue.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await expect(panel).toBeInTheDocument()
  },
}

/** Close off while busy, as in AssetDeleteConfirm (`:closable="!busy"`). */
export const CloseOffWhileBusy: Story = {
  render: () => ({
    components: { Dialog, Button },
    setup: () => ({ visible: ref(true), busy: ref(true) }),
    template: `
      <Dialog v-model:visible="visible" modal :closable="!busy" header="Delete hero?"
        :style="{ width: '28rem' }" data-testid="asset-delete-confirm">
        <p style="margin: 0">This can't be undone.</p>
        <template #footer>
          <Button label="Cancel" severity="secondary" text :disabled="busy" />
          <Button label="Deleting…" severity="danger" :loading="busy" />
        </template>
      </Dialog>`,
  }),
  play: async () => {
    const panel = await dialog()
    await expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true))
    await userEvent.keyboard('{Escape}')
    await expect(panel).toBeInTheDocument()
  },
}

/** Backdrop click closes, as in PublishPanel, HistoryPanel and AuditDrawer. */
export const DismissableMask: Story = {
  render: () => ({
    components: { Dialog },
    setup: () => ({ visible: ref(true) }),
    template: `
      <Dialog v-model:visible="visible" modal dismissableMask :closable="true" header="History — staging"
        :style="{ width: '620px', maxWidth: '95vw' }" data-testid="history-panel">
        <p style="margin: 0">No revisions yet.</p>
      </Dialog>`,
  }),
  play: async () => {
    const panel = await dialog()
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true))
    const mask = document.querySelector<HTMLElement>('.ui-dialog-mask')
    if (!mask) throw new Error('mask not rendered')
    await userEvent.pointer({ keys: '[MouseLeft]', target: mask, coords: { clientX: 4, clientY: 4 } })
    await closed()
  },
}
