/**
 * The cut 1 form controls (design-admin-ui.md, "The components"): the
 * behaviour cut 2's call sites rely on — PrimeVue's `indeterminate`, values
 * picked through `optionValue`, and items named and selected by an external
 * `<label for>`.
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import Checkbox from '../src/client/components/ui/Checkbox.vue'
import Listbox from '../src/client/components/ui/Listbox.vue'
import RadioGroup from '../src/client/components/ui/RadioGroup.vue'
import RadioGroupItem from '../src/client/components/ui/RadioGroupItem.vue'

// Reka's Listbox scrolls the highlighted option into view; jsdom has no layout.
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Checkbox', () => {
  it('renders aria-checked="mixed" when indeterminate', () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, indeterminate: true, binary: true } })
    expect(wrapper.get('[role="checkbox"]').attributes('aria-checked')).toBe('mixed')
  })

  it('emits the toggled boolean', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, binary: true } })
    await wrapper.get('[role="checkbox"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('puts inputId and data-testid on the checkbox, so an external label toggles it', async () => {
    const Host = defineComponent({
      components: { Checkbox },
      setup: () => ({ value: ref(false) }),
      template: `<div><Checkbox v-model="value" :binary="true" inputId="dest-staging" data-testid="cb" />
        <label for="dest-staging">staging</label></div>`,
    })
    const wrapper = mount(Host, { attachTo: document.body })
    const box = wrapper.get('[data-testid="cb"]')
    expect(box.attributes('id')).toBe('dest-staging')
    await wrapper.get('label').trigger('click')
    expect(box.attributes('aria-checked')).toBe('true')
  })
})

describe('Listbox', () => {
  it('emits the option value picked through optionValue', async () => {
    const wrapper = mount(Listbox, {
      props: {
        options: [
          { name: 'hero', id: 'h' },
          { name: 'footer', id: 'f' },
        ],
        optionLabel: 'name',
        optionValue: 'id',
        modelValue: null,
      },
    })
    const footer = wrapper.findAll('[role="option"]').find(o => o.text() === 'footer')
    await footer?.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['f']])
  })
})

describe('RadioGroup', () => {
  it('selects an item through its external <label for> (stories check the name)', async () => {
    const Host = defineComponent({
      components: { RadioGroup, RadioGroupItem },
      setup: () => ({ kind: ref('page') }),
      template: `<RadioGroup v-model="kind">
        <RadioGroupItem inputId="redirect-kind-page" value="page" /><label for="redirect-kind-page">Page</label>
        <RadioGroupItem inputId="redirect-kind-fragment" value="fragment" /><label for="redirect-kind-fragment">Fragment</label>
      </RadioGroup>`,
    })
    const wrapper = mount(Host, { attachTo: document.body })
    const fragment = wrapper.get('#redirect-kind-fragment')
    expect(fragment.attributes('role')).toBe('radio')
    expect(fragment.attributes('aria-checked')).toBe('false')

    await wrapper.get('label[for="redirect-kind-fragment"]').trigger('click')
    await nextTick()
    expect(fragment.attributes('aria-checked')).toBe('true')
    expect((wrapper.vm as unknown as { kind: string }).kind).toBe('fragment')
  })
})
