/**
 * ui/Button and its small siblings (design-admin-ui.md, cut 1): loading
 * disables and marks busy, icon-only buttons must have a name, attributes
 * fall through to the native element, TextInput's v-model and Spinner's label.
 */
import { mount } from '@vue/test-utils'
import { X } from '@lucide/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Button from '../src/client/components/ui/Button.vue'
import Spinner from '../src/client/components/ui/Spinner.vue'
import TextInput from '../src/client/components/ui/TextInput.vue'

afterEach(() => vi.restoreAllMocks())

describe('ui/Button', () => {
  it('disables the button and marks it busy while loading', () => {
    const w = mount(Button, { props: { label: 'Save', loading: true } })
    const el = w.get('button')
    expect(el.attributes('disabled')).toBeDefined()
    expect(el.attributes('aria-busy')).toBe('true')
  })

  it('warns when an icon-only button has no accessible name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(Button, { props: { icon: X } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('aria-label'))
  })

  it('does not warn for an icon-only button with aria-label, or a labelled one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(Button, { props: { icon: X }, attrs: { 'aria-label': 'Dismiss' } })
    mount(Button, { props: { icon: X, label: 'Close' } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes data-testid and title through to the native button', () => {
    const w = mount(Button, {
      props: { label: 'Publish' },
      attrs: { 'data-testid': 'publish-btn', title: 'Publish now' },
    })
    expect(w.get('button').attributes()).toMatchObject({ 'data-testid': 'publish-btn', title: 'Publish now' })
  })

  it('colours the badge with the button severity, primary by default', () => {
    const danger = mount(Button, { props: { label: 'x', badge: '3', severity: 'danger' } })
    expect(danger.get('.ui-button-badge').classes()).toContain('ui-button-badge--danger')
    const plain = mount(Button, { props: { label: 'x', badge: '3' } })
    expect(plain.get('.ui-button-badge').classes()).toContain('ui-button-badge--primary')
  })
})

describe('ui/TextInput', () => {
  it('updates its v-model', async () => {
    const w = mount(TextInput, {
      props: { modelValue: '', 'onUpdate:modelValue': (v: unknown) => w.setProps({ modelValue: v as string }) },
    })
    await w.get('input').setValue('about')
    expect(w.props('modelValue')).toBe('about')
  })
})

describe('ui/Spinner', () => {
  it('is a status named "Loading" unless given another label', () => {
    expect(mount(Spinner).get('[role="status"]').attributes('aria-label')).toBe('Loading')
    expect(
      mount(Spinner, { attrs: { 'aria-label': 'Loading history' } })
        .get('[role="status"]')
        .attributes('aria-label'),
    ).toBe('Loading history')
  })
})

describe('ui/Spinner strokeWidth', () => {
  it('draws with the stroke width call sites pass, defaulting to ProgressSpinner’s 2', () => {
    const widths = (w: ReturnType<typeof mount>) => w.findAll('circle').map(c => c.attributes('stroke-width'))
    expect(widths(mount(Spinner, { props: { strokeWidth: '4' } }))).toEqual(['4', '4'])
    expect(widths(mount(Spinner))).toEqual(['2', '2'])
  })
})
