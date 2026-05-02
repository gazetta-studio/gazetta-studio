/**
 * Vue component tests for AssetUploadPrompt.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import AssetUploadPrompt from '../src/client/components/AssetUploadPrompt.vue'
import { useAssetsUploadPromptStore } from '../src/client/stores/assetsUploadPrompt.js'

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
  document.body.innerHTML = ''
})

function render() {
  return mount(AssetUploadPrompt, {
    attachTo: document.body,
    global: { plugins: [PrimeVue] },
  })
}

const sampleFile = () => new File(['x'], 'hero.jpg', { type: 'image/jpeg' })

describe('AssetUploadPrompt', () => {
  it('is hidden by default', () => {
    render()
    expect(document.querySelector('[data-testid="upload-prompt"]')).toBeNull()
  })

  it('opens when the prompt store opens', async () => {
    const store = useAssetsUploadPromptStore()
    render()
    void store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' })
    await flushPromises()
    expect(document.querySelector('[data-testid="upload-prompt"]')).not.toBeNull()
  })

  it('replace-default click resolves the store Promise with replace-default', async () => {
    const store = useAssetsUploadPromptStore()
    const resolved = vi.fn()
    render()
    store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' }).then(resolved)
    await flushPromises()

    const replaceBtn = document.querySelector(
      '[data-testid="upload-prompt-replace-default"]',
    ) as HTMLButtonElement | null
    expect(replaceBtn).not.toBeNull()
    replaceBtn!.click()
    await flushPromises()

    expect(resolved).toHaveBeenCalledWith('replace-default')
  })

  it('add-override click resolves with add-override', async () => {
    const store = useAssetsUploadPromptStore()
    const resolved = vi.fn()
    render()
    store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' }).then(resolved)
    await flushPromises()

    const overrideBtn = document.querySelector('[data-testid="upload-prompt-add-override"]') as HTMLButtonElement | null
    expect(overrideBtn).not.toBeNull()
    overrideBtn!.click()
    await flushPromises()

    expect(resolved).toHaveBeenCalledWith('add-override')
  })

  it('cancel click resolves with cancel', async () => {
    const store = useAssetsUploadPromptStore()
    const resolved = vi.fn()
    render()
    store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' }).then(resolved)
    await flushPromises()

    const cancelBtn = document.querySelector('[data-testid="upload-prompt-cancel"]') as HTMLButtonElement | null
    expect(cancelBtn).not.toBeNull()
    cancelBtn!.click()
    await flushPromises()

    expect(resolved).toHaveBeenCalledWith('cancel')
  })

  it('shows the locale label and asset name in the prompt copy', async () => {
    const store = useAssetsUploadPromptStore()
    render()
    void store.prompt({
      file: sampleFile(),
      name: 'hero',
      locale: 'fr',
      activeLocaleLabel: 'French',
    })
    await flushPromises()

    const dialog = document.querySelector('[data-testid="upload-prompt"]')
    expect(dialog?.textContent).toContain('hero')
    expect(dialog?.textContent).toContain('French')
  })
})
