/**
 * Component tests for ConflictDiffView.vue.
 *
 *   - Walks union of top-level keys
 *   - Renders primitive fields with explicit "Yours" vs "Theirs"
 *   - Object/array fields render "(changes inside)" placeholder (v1)
 *   - "Only in mine" / "Only in theirs" labels for one-sided keys
 *   - Unchanged fields are omitted from the rendered list
 *   - Empty-state message when no top-level differences
 *   - Close button emits `close`
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import ConflictDiffView from '../src/client/components/ConflictDiffView.vue'

function mountDiff(current: Record<string, unknown>, pending: Record<string, unknown>) {
  return mount(ConflictDiffView, {
    props: { current, pending },
    global: { plugins: [PrimeVue] },
  })
}

describe('ConflictDiffView', () => {
  it('renders empty-state when both sides are identical', () => {
    const wrapper = mountDiff({ template: 't' }, { template: 't' })
    expect(wrapper.find('[data-testid="conflict-diff-empty"]').exists()).toBe(true)
  })

  it('shows primitive field diff with humanized label', () => {
    const wrapper = mountDiff({ template: 'old' }, { template: 'new' })
    expect(wrapper.find('[data-testid="conflict-diff-row-template"]').exists()).toBe(true)
    const pendingCell = wrapper.find('[data-testid="conflict-diff-pending-template"]').text()
    const currentCell = wrapper.find('[data-testid="conflict-diff-current-template"]').text()
    expect(pendingCell).toBe('new')
    expect(currentCell).toBe('old')
  })

  it('omits unchanged fields from the table', () => {
    // template is changed; route is identical → only template renders
    const wrapper = mountDiff({ template: 'old', route: '/about' }, { template: 'new', route: '/about' })
    expect(wrapper.find('[data-testid="conflict-diff-row-template"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conflict-diff-row-route"]').exists()).toBe(false)
  })

  it('object/array fields render "(changes inside)" rather than full content', () => {
    const wrapper = mountDiff(
      { content: { title: 'Theirs', body: 'long' } },
      { content: { title: 'Mine', body: 'long' } },
    )
    const pendingCell = wrapper.find('[data-testid="conflict-diff-pending-content"]').text()
    const currentCell = wrapper.find('[data-testid="conflict-diff-current-content"]').text()
    expect(pendingCell).toContain('changes inside')
    expect(currentCell).toContain('changes inside')
  })

  it('"only in mine" when key exists in pending but not current', () => {
    const wrapper = mountDiff({}, { metadata: { title: 'Mine' } })
    const currentCell = wrapper.find('[data-testid="conflict-diff-current-metadata"]').text()
    expect(currentCell).toContain('only in mine')
  })

  it('"only in theirs" when key exists in current but not pending', () => {
    const wrapper = mountDiff({ metadata: { title: 'Theirs' } }, {})
    const pendingCell = wrapper.find('[data-testid="conflict-diff-pending-metadata"]').text()
    expect(pendingCell).toContain('only in theirs')
  })

  it('treats deeply-equal object fields as unchanged', () => {
    // Same object content, different reference — JSON canonicalization
    // makes them equal.
    const wrapper = mountDiff(
      { content: { title: 'Same', tags: ['a', 'b'] } },
      { content: { title: 'Same', tags: ['a', 'b'] } },
    )
    expect(wrapper.find('[data-testid="conflict-diff-row-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conflict-diff-empty"]').exists()).toBe(true)
  })

  it('humanizes known field names (route → "Route", metadata → "Metadata")', () => {
    const wrapper = mountDiff({ route: '/old' }, { route: '/new' })
    expect(wrapper.text()).toContain('Route')
  })

  it('truncates very long string values', () => {
    const long = 'x'.repeat(200)
    // Truncation applies to whichever side carries the long value;
    // here the SERVER's current is long.
    const wrapper = mountDiff({ template: long }, { template: 'short' })
    const currentCell = wrapper.find('[data-testid="conflict-diff-current-template"]').text()
    expect(currentCell.length).toBeLessThan(long.length)
    expect(currentCell).toContain('…')
  })

  it('emits close when close button is clicked', async () => {
    const wrapper = mountDiff({ template: 'a' }, { template: 'b' })
    await wrapper.find('[data-testid="conflict-diff-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('handles array length differences', () => {
    const wrapper = mountDiff({ components: ['a'] }, { components: ['a', 'b', 'c'] })
    const pendingCell = wrapper.find('[data-testid="conflict-diff-pending-components"]').text()
    expect(pendingCell).toContain('3 items')
  })

  it('handles null vs missing key distinction', () => {
    // null is a present-with-null-value; missing is absent. Both
    // sides treat the value as `(only in ...)` only when truly absent.
    const wrapper = mountDiff({ content: null }, { content: { title: 'Mine' } })
    expect(wrapper.find('[data-testid="conflict-diff-row-content"]').exists()).toBe(true)
  })
})
