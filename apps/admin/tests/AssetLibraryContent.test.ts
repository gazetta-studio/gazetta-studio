import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AssetLibraryContent from '../src/client/components/AssetLibraryContent.vue'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('AssetLibraryContent', () => {
  it('renders the three composed sub-components', () => {
    const wrapper = mount(AssetLibraryContent, {
      global: {
        stubs: {
          AssetUploadZone: { template: '<div data-testid="stub-upload" />' },
          AssetLibraryGrid: { template: '<div data-testid="stub-grid" />' },
          AssetDetail: { template: '<div data-testid="stub-detail" />' },
        },
      },
    })

    expect(wrapper.find('[data-testid="asset-library-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-upload"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-detail"]').exists()).toBe(true)
  })
})
