/**
 * Tests for the upload-prompt store. Verifies the Promise-based modal
 * contract: prompt() returns a Promise that resolves to the user's pick.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsUploadPromptStore } from '../src/client/stores/assetsUploadPrompt.js'

const sampleFile = () => new File(['content'], 'hero.jpg', { type: 'image/jpeg' })

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useAssetsUploadPromptStore', () => {
  it('opens the modal when prompt() is called', () => {
    const store = useAssetsUploadPromptStore()
    expect(store.isOpen).toBe(false)

    void store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' })

    expect(store.isOpen).toBe(true)
    expect(store.current?.locale).toBe('fr')
    expect(store.current?.name).toBe('hero')
  })

  it('resolves the Promise with the picked choice', async () => {
    const store = useAssetsUploadPromptStore()
    const promise = store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' })

    store.pick('add-override')

    await expect(promise).resolves.toBe('add-override')
    expect(store.isOpen).toBe(false)
    expect(store.current).toBeNull()
  })

  it('resolves with cancel when dismiss() is called', async () => {
    const store = useAssetsUploadPromptStore()
    const promise = store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' })

    store.dismiss()

    await expect(promise).resolves.toBe('cancel')
    expect(store.isOpen).toBe(false)
  })

  it('cancels the previous prompt when a new one is started', async () => {
    const store = useAssetsUploadPromptStore()
    const first = store.prompt({ file: sampleFile(), name: 'hero', locale: 'fr' })

    // Start a second prompt before resolving the first.
    const second = store.prompt({ file: sampleFile(), name: 'banner', locale: 'ar' })

    // First should auto-resolve to cancel.
    await expect(first).resolves.toBe('cancel')

    // Modal still open for the second.
    expect(store.isOpen).toBe(true)
    expect(store.current?.name).toBe('banner')

    store.pick('replace-default')
    await expect(second).resolves.toBe('replace-default')
  })

  it('passes through optional locale labels', () => {
    const store = useAssetsUploadPromptStore()
    void store.prompt({
      file: sampleFile(),
      name: 'hero',
      locale: 'fr',
      activeLocaleLabel: 'French',
      defaultLocaleLabel: 'English',
    })

    expect(store.current?.activeLocaleLabel).toBe('French')
    expect(store.current?.defaultLocaleLabel).toBe('English')
  })
})
