/**
 * TargetCapabilities.vue renders the server's capabilities rows
 * (design-public-storage.md, UX check): one `target-capability-{key}`
 * per row, with the copy as given and backticked names as code.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TargetCapabilities from '../src/client/components/TargetCapabilities.vue'
import type { TargetInfo } from '../src/client/api/client.js'

const target: TargetInfo = {
  name: 'production',
  environment: 'production',
  type: 'static',
  editable: false,
  altText: { available: false, auto: false },
  capabilities: { has: [], gaps: [] },
  publicStorage: true,
  auditHome: { kind: 'target', name: 'local' },
  about: [
    { key: 'storage', label: 'Storage', value: 'Public (assumed)' },
    { key: 'history', label: 'History', value: 'Off: storage is public' },
    { key: 'audit', label: 'Audit', value: 'Kept on `local`' },
    { key: 'deploy', label: 'Deploy', value: 'None' },
  ],
}

// The Dialog teleports into document.body; clear what earlier tests left.
beforeEach(() => {
  document.body.innerHTML = ''
})

async function render(t: TargetInfo | null, visible = true) {
  const w = mount(TargetCapabilities, { props: { visible, target: t }, attachTo: document.body })
  await flushPromises()
  return w
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim()

describe('TargetCapabilities', () => {
  it('renders one row per about entry with its test id, label and value', async () => {
    const w = await render(target)
    const root = document.querySelector('[data-testid="target-capabilities"]')
    expect(root).not.toBeNull()
    expect(root?.textContent).toContain('About production')
    for (const row of target.about) {
      const el = document.querySelector(`[data-testid="target-capability-${row.key}"]`)
      expect(text(el?.querySelector('dt'))).toBe(row.label)
      expect(text(el?.querySelector('dd'))).toBe(row.value.replaceAll('`', ''))
    }
    expect(document.querySelectorAll('[data-testid^="target-capability-"]')).toHaveLength(target.about.length)
    w.unmount()
  })

  it('shows backticked names as code', async () => {
    const w = await render(target)
    const audit = document.querySelector('[data-testid="target-capability-audit"] dd')
    expect(text(audit?.querySelector('code'))).toBe('local')
    expect(text(audit)).toBe('Kept on local')
    w.unmount()
  })

  it('renders nothing while closed', async () => {
    const w = await render(target, false)
    expect(document.querySelector('[data-testid="target-capabilities"]')).toBeNull()
    w.unmount()
  })

  it('closes from its Close button', async () => {
    const w = await render(target)
    ;(document.querySelector('[data-testid="target-capabilities-close"]') as HTMLButtonElement).click()
    await w.vm.$nextTick()
    expect(w.emitted('update:visible')?.at(-1)).toEqual([false])
    w.unmount()
  })
})
