/**
 * StateBadge — tests pinning the primitive's contract.
 *
 * Pins (per design-review-workflow.md "UX implementation foundation"
 * + the cut's ## Acceptance):
 *   - dot variant renders as a 6px span with the right color class
 *   - pill variant renders a labeled span with the right color class
 *   - every (variant × color) combination resolves a token class
 *   - label on dot = aria-label; label on pill = visible text
 *   - no label and no tooltip on a dot = aria-hidden="true"
 *   - tooltip = title attribute on both variants
 *   - data-testid passes through to the root span
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import StateBadge from '../src/client/components/StateBadge.vue'

const COLORS = ['warning', 'danger', 'success', 'info', 'muted'] as const

describe('StateBadge — dot variant', () => {
  it('renders a span with dot classes', () => {
    const wrapper = mount(StateBadge, { props: { variant: 'dot', color: 'warning' } })
    expect(wrapper.element.tagName).toBe('SPAN')
    expect(wrapper.classes()).toContain('state-badge')
    expect(wrapper.classes()).toContain('state-badge-dot')
  })

  it.each(COLORS)('applies state-badge-%s class', color => {
    const wrapper = mount(StateBadge, { props: { variant: 'dot', color } })
    expect(wrapper.classes()).toContain(`state-badge-${color}`)
  })

  it('exposes label as aria-label when provided, and takes role="img" (axe aria-prohibited-attr guard)', () => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'dot', color: 'warning', label: 'Dirty' },
    })
    expect(wrapper.attributes('aria-label')).toBe('Dirty')
    expect(wrapper.attributes('role')).toBe('img')
  })

  it('marks itself aria-hidden="true" when no label and no tooltip is given, and omits role', () => {
    const wrapper = mount(StateBadge, { props: { variant: 'dot', color: 'warning' } })
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.attributes('role')).toBeUndefined()
  })

  it('is not aria-hidden when a tooltip is provided (hover context has meaning)', () => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'dot', color: 'warning', tooltip: 'Hover me' },
    })
    expect(wrapper.attributes('aria-hidden')).toBeUndefined()
  })

  it('exposes tooltip as title attribute', () => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'dot', color: 'warning', tooltip: 'Hover me' },
    })
    expect(wrapper.attributes('title')).toBe('Hover me')
  })

  it('does not render label text visually on the dot variant', () => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'dot', color: 'warning', label: 'Dirty' },
    })
    expect(wrapper.text()).toBe('')
  })
})

describe('StateBadge — pill variant', () => {
  it('renders a span with pill classes + visible label text', () => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'pill', color: 'muted', label: 'EN' },
    })
    expect(wrapper.classes()).toContain('state-badge-pill')
    expect(wrapper.text()).toBe('EN')
  })

  it.each(COLORS)('applies state-badge-%s class', color => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'pill', color, label: 'LBL' },
    })
    expect(wrapper.classes()).toContain(`state-badge-${color}`)
  })

  it('exposes tooltip as title attribute', () => {
    const wrapper = mount(StateBadge, {
      props: { variant: 'pill', color: 'muted', label: 'FR', tooltip: 'French (fr)' },
    })
    expect(wrapper.attributes('title')).toBe('French (fr)')
  })
})

describe('StateBadge — data-testid passthrough', () => {
  it('forwards data-testid attribute to the root element on the dot variant', () => {
    const wrapper = mount(StateBadge, {
      attrs: { 'data-testid': 'review-state' },
      props: { variant: 'dot', color: 'warning' },
    })
    expect(wrapper.attributes('data-testid')).toBe('review-state')
  })

  it('forwards data-testid attribute to the root element on the pill variant', () => {
    const wrapper = mount(StateBadge, {
      attrs: { 'data-testid': 'locale-chip' },
      props: { variant: 'pill', color: 'muted', label: 'EN' },
    })
    expect(wrapper.attributes('data-testid')).toBe('locale-chip')
  })
})
