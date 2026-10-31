/**
 * Banner — tests pinning the primitive's contract
 * (design-review-workflow.md "UX implementation foundation"):
 * severity drives class + default icon + default role; `role` / `icon`
 * override; default and `#actions` slots render; dismiss is opt-in and
 * emits rather than hiding.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { Archive, CircleCheck, CircleX, Info, TriangleAlert } from '@lucide/vue'
import Banner from '../src/client/components/Banner.vue'

type Props = InstanceType<typeof Banner>['$props']

function render(props: Props, slots: Record<string, string> = { default: 'Message' }) {
  return mount(Banner, { props, slots })
}

describe('Banner — severity', () => {
  it.each([
    ['danger', 'alert', CircleX],
    ['warning', 'alert', TriangleAlert],
    ['info', 'status', Info],
    ['success', 'status', CircleCheck],
  ] as const)('%s → role=%s, its icon, severity class', (severity, role, icon) => {
    const wrapper = render({ severity })
    expect(wrapper.classes()).toContain(`banner-${severity}`)
    expect(wrapper.attributes('data-severity')).toBe(severity)
    expect(wrapper.attributes('role')).toBe(role)
    const iconEl = wrapper.findComponent(icon)
    expect(iconEl.exists()).toBe(true)
    expect(iconEl.classes()).toContain('banner-icon')
    expect(iconEl.attributes('aria-hidden')).toBe('true')
  })

  it('role prop overrides the severity default', () => {
    expect(render({ severity: 'warning', role: 'status' }).attributes('role')).toBe('status')
    expect(render({ severity: 'info', role: 'alert' }).attributes('role')).toBe('alert')
  })

  it('icon prop replaces the severity default', () => {
    const wrapper = render({ severity: 'warning', icon: Archive })
    expect(wrapper.findComponent(Archive).classes()).toContain('banner-icon')
    expect(wrapper.findComponent(TriangleAlert).exists()).toBe(false)
  })
})

describe('Banner — slots', () => {
  it('renders default slot content as the message', () => {
    const wrapper = render({ severity: 'info' }, { default: '<strong>Draft</strong> — not submitted.' })
    expect(wrapper.find('.banner-text').html()).toContain('<strong>Draft</strong>')
  })

  it('renders the actions slot inside the actions region', () => {
    const wrapper = render(
      { severity: 'warning' },
      { default: 'Pending', actions: '<button data-testid="act">Approve</button>' },
    )
    expect(wrapper.find('.banner-actions [data-testid="act"]').exists()).toBe(true)
  })

  it('omits the actions region when the slot is empty', () => {
    expect(render({ severity: 'warning' }).find('.banner-actions').exists()).toBe(false)
  })
})

describe('Banner — dismiss', () => {
  it('has no dismiss button unless dismissible', () => {
    expect(render({ severity: 'info' }).find('[data-testid="banner-dismiss"]').exists()).toBe(false)
  })

  it('emits dismiss once per click and stays rendered (consumer owns visibility)', async () => {
    const wrapper = render({ severity: 'info', dismissible: true })
    const dismiss = wrapper.find('[data-testid="banner-dismiss"]')
    expect(dismiss.attributes('aria-label')).toBe('Dismiss')
    await dismiss.trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
    expect(wrapper.find('.banner').exists()).toBe(true)
  })
})

describe('Banner — attribute passthrough', () => {
  it('forwards data-testid to the root', () => {
    const wrapper = mount(Banner, {
      props: { severity: 'info' },
      attrs: { 'data-testid': 'review-banner' },
    })
    expect(wrapper.attributes('data-testid')).toBe('review-banner')
  })
})
