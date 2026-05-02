/**
 * Vue tests for AssetFocalPointEditor — the click-and-drag focal point
 * picker with aspect-ratio previews.
 *
 * jsdom limitations: pointer events have no real coordinate plumbing
 * relative to elements (getBoundingClientRect returns 0/0/0/0 for
 * unrendered elements). We construct synthetic PointerEvent / MouseEvent
 * objects with explicit clientX/clientY and stub the image's
 * `getBoundingClientRect` so the component can compute a normalized
 * point from them.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AssetFocalPointEditor from '../src/client/components/AssetFocalPointEditor.vue'

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
})

const IMG_URL = 'data:image/png;base64,test'

function render(modelValue: { x: number; y: number } | null = null) {
  const wrapper = mount(AssetFocalPointEditor, {
    props: { modelValue, imageUrl: IMG_URL, alt: 'sample' },
    global: { plugins: [PrimeVue] },
  })

  // Stub getBoundingClientRect on the image so pointer events translate
  // to coordinates the component understands. Using 200×100 makes the
  // arithmetic obvious in tests (100, 50) → (0.5, 0.5).
  const img = wrapper.find('img').element as HTMLImageElement
  Object.defineProperty(img, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }),
  })
  return wrapper
}

describe('AssetFocalPointEditor', () => {
  it('renders the marker at the center when modelValue is null', () => {
    const wrapper = render(null)
    const marker = wrapper.find<HTMLElement>('[data-testid="focal-marker"]')
    expect(marker.attributes('style')).toContain('left: 50%')
    expect(marker.attributes('style')).toContain('top: 50%')
  })

  it('renders the marker at the explicit modelValue', () => {
    const wrapper = render({ x: 0.25, y: 0.75 })
    const marker = wrapper.find<HTMLElement>('[data-testid="focal-marker"]')
    expect(marker.attributes('style')).toContain('left: 25%')
    expect(marker.attributes('style')).toContain('top: 75%')
  })

  it('shows the "default" hint when modelValue is null', () => {
    const wrapper = render(null)
    expect(wrapper.find('[data-testid="focal-default-hint"]').exists()).toBe(true)
  })

  it('hides the "default" hint once the focal point is set', () => {
    const wrapper = render({ x: 0.5, y: 0.5 })
    expect(wrapper.find('[data-testid="focal-default-hint"]').exists()).toBe(false)
  })

  it('renders the x/y badge as percentages', () => {
    const wrapper = render({ x: 0.42, y: 0.13 })
    expect(wrapper.find('[data-testid="focal-xy"]').text()).toBe('42% × 13%')
  })

  it('emits update on click', async () => {
    const wrapper = render(null)
    const stage = wrapper.find('[data-testid="focal-stage"]')
    // Click at 100/50 in the 200×100 stub → (0.5, 0.5) normalized.
    await stage.trigger('click', { clientX: 100, clientY: 50 })

    const events = wrapper.emitted('update:modelValue')!
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual([{ x: 0.5, y: 0.5 }])
  })

  it('clamps clicks outside the image rect to [0, 1]', async () => {
    const wrapper = render(null)
    const stage = wrapper.find('[data-testid="focal-stage"]')
    // Click far left → clamps to x=0.
    await stage.trigger('click', { clientX: -50, clientY: 50 })
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([{ x: 0, y: 0.5 }])
  })

  it('emits null when reset clicked', async () => {
    const wrapper = render({ x: 0.5, y: 0.5 })
    const reset = wrapper.find('[data-testid="focal-reset"]')
    // PrimeVue Button renders a real <button>; trigger via the inner element.
    await reset.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([null])
  })

  it('disables reset when modelValue is null (already default)', () => {
    const wrapper = render(null)
    const reset = wrapper.find('[data-testid="focal-reset"]')
    // PrimeVue stamps the disabled attribute when :disabled is true.
    const button = reset.element as HTMLButtonElement
    expect(button.disabled || button.classList.contains('p-disabled')).toBe(true)
  })

  it('renders four aspect-ratio previews', () => {
    const wrapper = render({ x: 0.5, y: 0.5 })
    expect(wrapper.find('[data-testid="focal-preview-1:1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="focal-preview-16:9"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="focal-preview-4:5"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="focal-preview-9:16"]').exists()).toBe(true)
  })

  it('preview thumbnails reflect the focal via object-position', () => {
    const wrapper = render({ x: 0.3, y: 0.7 })
    const preview = wrapper.find('[data-testid="focal-preview-1:1"] img')
    expect(preview.attributes('style')).toContain('object-position: 30% 70%')
  })

  it('shows the hover marker when not dragging', async () => {
    const wrapper = render({ x: 0.5, y: 0.5 })
    const stageEl = wrapper.find('[data-testid="focal-stage"]').element as HTMLElement

    // vue-test-utils' synthetic events lock down clientX/Y as read-only,
    // so dispatch a real PointerEvent directly. jsdom supports the
    // PointerEvent constructor (with the explicit interface init dict).
    stageEl.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 50,
        clientY: 25,
        pointerId: 1,
        bubbles: true,
      }),
    )
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="focal-hover-marker"]').exists()).toBe(true)
  })

  it('hides the hover marker on pointer leave', async () => {
    const wrapper = render({ x: 0.5, y: 0.5 })
    const stageEl = wrapper.find('[data-testid="focal-stage"]').element as HTMLElement
    stageEl.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 50,
        clientY: 25,
        pointerId: 1,
        bubbles: true,
      }),
    )
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="focal-hover-marker"]').exists()).toBe(true)

    stageEl.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="focal-hover-marker"]').exists()).toBe(false)
  })
})
