/**
 * ui/Dialog — the contract cut 2's import swap relies on (design-admin-ui.md,
 * "The components"): the close button and Escape follow `closable`, a backdrop
 * click closes only with `dismissableMask`, and the header names the dialog.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import Dialog from '../src/client/components/ui/Dialog.vue'

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

async function open(props: Record<string, unknown> = {}) {
  wrapper = mount(Dialog, {
    props: { visible: true, header: 'Unsaved Changes', ...props },
    slots: { default: '<p>Body</p>', footer: '<button>Save</button>' },
    attrs: { 'data-testid': 'dlg' },
    attachTo: document.body,
  })
  await flushPromises()
  const panel = document.querySelector<HTMLElement>('[data-testid="dlg"]')
  if (!panel) throw new Error('dialog panel not rendered')
  return { wrapper, panel }
}

function closeButton() {
  return document.querySelector('button[aria-label="Close"]')
}

function pressEscape(target: HTMLElement) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

// Reka's DismissableLayer listens for pointerdown on the document, outside the panel.
async function clickBackdrop() {
  const mask = document.querySelector<HTMLElement>('.ui-dialog-mask')
  if (!mask) throw new Error('mask not rendered')
  mask.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
  mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  await flushPromises()
}

describe('ui/Dialog — closable', () => {
  it('renders a Close button and closes on Escape by default', async () => {
    const { wrapper, panel } = await open()
    expect(closeButton()).not.toBeNull()
    pressEscape(panel)
    await flushPromises()
    expect(wrapper.emitted('update:visible')).toEqual([[false]])
  })

  it('closable=false: no Close button, and Escape does not close', async () => {
    const { wrapper, panel } = await open({ closable: false })
    expect(closeButton()).toBeNull()
    pressEscape(panel)
    await flushPromises()
    expect(wrapper.emitted('update:visible')).toBeUndefined()
  })
})

describe('ui/Dialog — dismissableMask', () => {
  it('a backdrop click does not close without dismissableMask', async () => {
    const { wrapper } = await open()
    await clickBackdrop()
    expect(wrapper.emitted('update:visible')).toBeUndefined()
  })

  it('a backdrop click closes with dismissableMask', async () => {
    const { wrapper } = await open({ dismissableMask: true })
    await clickBackdrop()
    expect(wrapper.emitted('update:visible')).toEqual([[false]])
  })
})

describe('ui/Dialog — accessible name and attributes', () => {
  it('names the dialog by its header', async () => {
    const { panel } = await open()
    expect(panel.getAttribute('role')).toBe('dialog')
    const title = document.getElementById(panel.getAttribute('aria-labelledby') ?? '')
    expect(title?.textContent).toBe('Unsaved Changes')
  })

  it('puts attributes on the panel and pt.mask.style on the overlay', async () => {
    const { panel } = await open({ pt: { mask: { style: 'backdrop-filter: blur(2px)' } } })
    expect(panel.classList.contains('ui-dialog')).toBe(true)
    expect(document.querySelector<HTMLElement>('.ui-dialog-mask')?.getAttribute('style')).toContain('blur(2px)')
  })
})
