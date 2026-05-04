/**
 * Component tests for ValidationBanner.vue.
 *
 * Scope:
 *   - Hidden when no issues
 *   - Renders headline with error count when populated
 *   - One row per issue with validator name + message
 *   - Dismiss button clears the store
 *   - Severity-driven icon class
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ValidationBanner from '../src/client/components/ValidationBanner.vue'
import { useValidationIssuesStore } from '../src/client/stores/validationIssues.js'
import type { ValidationIssue } from '../src/client/api/client.js'

const ASSET_ISSUE: ValidationIssue = {
  validator: 'referenced-asset-exists',
  severity: 'error',
  message: 'Asset "hero" missing.',
  itemPath: 'pages/home/page.json',
  contentPath: 'hero',
}
const WARN_ISSUE: ValidationIssue = {
  validator: 'unused-fragment',
  severity: 'warn',
  message: 'Fragment "old" is unused.',
  itemPath: 'fragments/old/fragment.json',
}

function mountBanner() {
  return mount(ValidationBanner, {
    global: { plugins: [PrimeVue] },
  })
}

describe('ValidationBanner', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders nothing when no issues', () => {
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="validation-banner"]').exists()).toBe(false)
  })

  it('renders banner when issues are present', () => {
    const store = useValidationIssuesStore()
    store.set([ASSET_ISSUE])
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="validation-banner"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('1 validation error blocked the save')
    expect(wrapper.text()).toContain('Asset "hero" missing.')
  })

  it('pluralizes errors correctly', () => {
    const store = useValidationIssuesStore()
    store.set([ASSET_ISSUE, { ...ASSET_ISSUE, validator: 'circular-fragment' }])
    const wrapper = mountBanner()
    expect(wrapper.text()).toContain('2 validation errors blocked the save')
  })

  it('shows non-blocking aside when warns are present alongside errors', () => {
    const store = useValidationIssuesStore()
    store.set([ASSET_ISSUE, WARN_ISSUE])
    const wrapper = mountBanner()
    expect(wrapper.text()).toContain('+1 non-blocking')
  })

  it('renders one row per issue with validator id testid', () => {
    const store = useValidationIssuesStore()
    store.set([ASSET_ISSUE, WARN_ISSUE])
    const wrapper = mountBanner()
    expect(wrapper.find('[data-testid="validation-issue-referenced-asset-exists"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="validation-issue-unused-fragment"]').exists()).toBe(true)
  })

  it('renders contentPath when present', () => {
    const store = useValidationIssuesStore()
    store.set([ASSET_ISSUE])
    const wrapper = mountBanner()
    expect(wrapper.text()).toContain('hero')
  })

  it('dismiss button clears the store', async () => {
    const store = useValidationIssuesStore()
    store.set([ASSET_ISSUE])
    const wrapper = mountBanner()
    await wrapper.find('[data-testid="validation-banner-dismiss"]').trigger('click')
    expect(store.hasIssues).toBe(false)
  })
})
