import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AssetUploadZone from '../src/client/components/AssetUploadZone.vue'
import { useActiveTargetStore } from '../src/client/stores/activeTarget.js'
import { useAssetsUploadStore } from '../src/client/stores/assetsUpload.js'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsUploadPromptStore } from '../src/client/stores/assetsUploadPrompt.js'
import { useSiteStore } from '../src/client/stores/site.js'
import { useLocaleStore } from '../src/client/stores/locale.js'
import type { AssetSummary } from 'gazetta/schema'

function setSiteAndLocale(supported: string[], defaultLocale: string, active: string | null) {
  const site = useSiteStore()
  site.manifest = { name: 'test', locale: defaultLocale, locales: { supported } } as unknown as typeof site.manifest
  const locale = useLocaleStore()
  locale.setLocale(active)
}

function existingAsset(name: string, overrideLocales: string[] = []): AssetSummary {
  return {
    name,
    kind: 'embedded',
    mime: 'image/jpeg',
    size: 1000,
    hash: 'aaaaaaaa',
    width: 100,
    height: 100,
    alt: null,
    uploadedAt: '2026-04-22T00:00:00.000Z',
    overrideLocales,
    overrideThemes: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

function fakeFile(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' })
}

describe('AssetUploadZone', () => {
  it('renders a drop zone and a hidden file input', () => {
    const wrapper = mount(AssetUploadZone)
    expect(wrapper.find('[data-testid="asset-upload-zone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="asset-upload-input"]').exists()).toBe(true)
  })

  it('enqueues files dropped into the zone', async () => {
    const uploads = useAssetsUploadStore()
    uploads.configure({ uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })) })
    const enqueue = vi.spyOn(uploads, 'enqueue')

    const wrapper = mount(AssetUploadZone)
    await wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
      dataTransfer: { files: [fakeFile('My Hero.jpg'), fakeFile('logo.png')] },
    })

    expect(enqueue).toHaveBeenCalledTimes(2)
    // deriveName slugifies "My Hero" → "my-hero"
    expect(enqueue.mock.calls[0][1]).toBe('my-hero')
    expect(enqueue.mock.calls[1][1]).toBe('logo')
  })

  it('enqueues files picked via the file input', async () => {
    const uploads = useAssetsUploadStore()
    uploads.configure({ uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'x' })) })
    const enqueue = vi.spyOn(uploads, 'enqueue')

    const wrapper = mount(AssetUploadZone)
    const input = wrapper.find<HTMLInputElement>('[data-testid="asset-upload-input"]')

    // jsdom: Object.defineProperty to set `files` since input.files is read-only
    const files = [fakeFile('Hero.jpg')]
    Object.defineProperty(input.element, 'files', { value: files, configurable: true })
    await input.trigger('change')

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0][1]).toBe('hero')
  })

  it('adds the dragging class while a file is being dragged over the zone', async () => {
    const wrapper = mount(AssetUploadZone)
    const zone = wrapper.find('[data-testid="asset-upload-zone"]')
    await zone.trigger('dragover', { dataTransfer: {} })
    expect(zone.classes()).toContain('dragging')
    await zone.trigger('dragleave')
    expect(zone.classes()).not.toContain('dragging')
  })

  it('renders a per-file status list while uploads are queued', async () => {
    const uploads = useAssetsUploadStore()
    // Hang the upload so we can observe the in-flight state.
    let release: (() => void) | null = null
    const hang = new Promise<void>(r => {
      release = r
    })
    uploads.configure({
      uploadAsset: async () => {
        await hang
        return { manifest: {} as never, bytesPath: 'x' }
      },
    })

    const wrapper = mount(AssetUploadZone)
    uploads.enqueue(fakeFile('a.jpg'), 'a', null)
    uploads.enqueue(fakeFile('b.jpg'), 'b', null)
    await flushPromises()

    const list = wrapper.find('[data-testid="asset-upload-list"]')
    expect(list.exists()).toBe(true)
    expect(wrapper.findAll('[data-testid^="upload-u-"]')).toHaveLength(2)

    release!()
  })

  describe('locale routing', () => {
    it('uploads to default when active locale equals default', async () => {
      setSiteAndLocale(['en', 'fr'], 'en', 'en')
      const uploads = useAssetsUploadStore()
      const list = useAssetsListStore()
      list.assets = [existingAsset('hero')]
      const enqueue = vi.spyOn(uploads, 'enqueue')
      const enqueueLocale = vi.spyOn(uploads, 'enqueueLocaleBytes')

      const wrapper = mount(AssetUploadZone)
      await wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
        dataTransfer: { files: [fakeFile('hero.jpg')] },
      })
      await flushPromises()

      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueueLocale).not.toHaveBeenCalled()
    })

    it('uploads to default when no name collision (new asset on non-default locale)', async () => {
      setSiteAndLocale(['en', 'fr'], 'en', 'fr')
      const uploads = useAssetsUploadStore()
      const list = useAssetsListStore()
      list.assets = [existingAsset('other')]
      const enqueue = vi.spyOn(uploads, 'enqueue')
      const enqueueLocale = vi.spyOn(uploads, 'enqueueLocaleBytes')

      const wrapper = mount(AssetUploadZone)
      await wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
        dataTransfer: { files: [fakeFile('newasset.jpg')] },
      })
      await flushPromises()

      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueueLocale).not.toHaveBeenCalled()
    })

    it('opens the prompt when active locale != default AND name collides', async () => {
      setSiteAndLocale(['en', 'fr'], 'en', 'fr')
      const list = useAssetsListStore()
      list.assets = [existingAsset('hero')]
      const promptStore = useAssetsUploadPromptStore()
      const promptSpy = vi.spyOn(promptStore, 'prompt')

      const wrapper = mount(AssetUploadZone)
      await wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
        dataTransfer: { files: [fakeFile('hero.jpg')] },
      })
      await flushPromises()

      expect(promptSpy).toHaveBeenCalledTimes(1)
      expect(promptSpy.mock.calls[0][0].locale).toBe('fr')
      expect(promptSpy.mock.calls[0][0].name).toBe('hero')
    })

    it('routes to enqueue when prompt resolves replace-default', async () => {
      setSiteAndLocale(['en', 'fr'], 'en', 'fr')
      const list = useAssetsListStore()
      list.assets = [existingAsset('hero')]
      const uploads = useAssetsUploadStore()
      const promptStore = useAssetsUploadPromptStore()
      const enqueue = vi.spyOn(uploads, 'enqueue')
      const enqueueLocale = vi.spyOn(uploads, 'enqueueLocaleBytes')

      const wrapper = mount(AssetUploadZone)
      const dropPromise = wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
        dataTransfer: { files: [fakeFile('hero.jpg')] },
      })
      await flushPromises()

      promptStore.pick('replace-default')
      await dropPromise
      await flushPromises()

      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(enqueueLocale).not.toHaveBeenCalled()
    })

    it('routes to enqueueLocaleBytes when prompt resolves add-override', async () => {
      setSiteAndLocale(['en', 'fr'], 'en', 'fr')
      const list = useAssetsListStore()
      list.assets = [existingAsset('hero')]
      const uploads = useAssetsUploadStore()
      const promptStore = useAssetsUploadPromptStore()
      const enqueue = vi.spyOn(uploads, 'enqueue')
      const enqueueLocale = vi.spyOn(uploads, 'enqueueLocaleBytes')

      const wrapper = mount(AssetUploadZone)
      const dropPromise = wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
        dataTransfer: { files: [fakeFile('hero.jpg')] },
      })
      await flushPromises()

      promptStore.pick('add-override')
      await dropPromise
      await flushPromises()

      expect(enqueueLocale).toHaveBeenCalledTimes(1)
      expect(enqueueLocale.mock.calls[0][1]).toBe('hero')
      expect(enqueueLocale.mock.calls[0][2]).toEqual({ locale: 'fr' })
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('does nothing when prompt resolves cancel', async () => {
      setSiteAndLocale(['en', 'fr'], 'en', 'fr')
      const list = useAssetsListStore()
      list.assets = [existingAsset('hero')]
      const uploads = useAssetsUploadStore()
      const promptStore = useAssetsUploadPromptStore()
      const enqueue = vi.spyOn(uploads, 'enqueue')
      const enqueueLocale = vi.spyOn(uploads, 'enqueueLocaleBytes')

      const wrapper = mount(AssetUploadZone)
      const dropPromise = wrapper.find('[data-testid="asset-upload-zone"]').trigger('drop', {
        dataTransfer: { files: [fakeFile('hero.jpg')] },
      })
      await flushPromises()

      promptStore.pick('cancel')
      await dropPromise
      await flushPromises()

      expect(enqueue).not.toHaveBeenCalled()
      expect(enqueueLocale).not.toHaveBeenCalled()
    })
  })

  describe('inline alt entry on successful uploads', () => {
    it('shows alt input + decorative checkbox for image uploads after success', async () => {
      const uploads = useAssetsUploadStore()
      uploads.configure({
        uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
      })

      const wrapper = mount(AssetUploadZone)
      const id = uploads.enqueue(fakeFile('hero.jpg'), 'hero', null)
      await flushPromises()

      // Wait for the queue to drain (mocked upload resolves immediately).
      const altInput = wrapper.find(`[data-testid="upload-${id}-alt-input"]`)
      expect(altInput.exists()).toBe(true)
      const decorativeBox = wrapper.find(`[data-testid="upload-${id}-alt-decorative"]`)
      expect(decorativeBox.exists()).toBe(true)
    })

    it('does not show the alt entry block while still uploading', async () => {
      const uploads = useAssetsUploadStore()
      let release: (() => void) | null = null
      const hang = new Promise<void>(r => {
        release = r
      })
      uploads.configure({
        uploadAsset: async () => {
          await hang
          return { manifest: {} as never, bytesPath: 'assets/x' }
        },
      })

      const wrapper = mount(AssetUploadZone)
      const id = uploads.enqueue(fakeFile('hero.jpg'), 'hero', null)
      await flushPromises()

      // Mid-upload — no alt block yet.
      const altWrap = wrapper.find(`[data-testid="upload-${id}-alt"]`)
      expect(altWrap.exists()).toBe(false)

      release!()
      await flushPromises()
      // After completion the block appears.
      const altWrapAfter = wrapper.find(`[data-testid="upload-${id}-alt"]`)
      expect(altWrapAfter.exists()).toBe(true)
    })

    it('does not show the alt entry block for non-image uploads', async () => {
      // Pretend a PDF upload succeeded — even though the upload accept
      // attribute today restricts to image/jpeg/png, this guards future
      // wide MIME support.
      const uploads = useAssetsUploadStore()
      uploads.configure({
        uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
      })

      const wrapper = mount(AssetUploadZone)
      const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', { type: 'application/pdf' })
      const id = uploads.enqueue(pdf, 'doc', null)
      await flushPromises()

      const altWrap = wrapper.find(`[data-testid="upload-${id}-alt"]`)
      expect(altWrap.exists()).toBe(false)
    })

    it('does not show the alt entry block for locale-bytes uploads', async () => {
      // Locale-bytes uploads inherit alt from the default; the inline
      // entry is for default-asset uploads only.
      const uploads = useAssetsUploadStore()
      uploads.configure({
        uploadLocaleBytes: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
      })

      const wrapper = mount(AssetUploadZone)
      const id = uploads.enqueueLocaleBytes(fakeFile('hero.jpg'), 'hero', { locale: 'fr' })
      await flushPromises()

      const altWrap = wrapper.find(`[data-testid="upload-${id}-alt"]`)
      expect(altWrap.exists()).toBe(false)
    })
  })

  describe('AI alt-text auto-suggestion', () => {
    function activateTargetWithAi(available: boolean, auto: boolean) {
      const targets = useActiveTargetStore()
      targets.targets = [
        {
          name: 'local',
          environment: 'local',
          type: 'static',
          editable: true,
          altText: { available, auto },
        },
      ]
      targets.activeTargetName = 'local'
    }

    function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return handler(url, init)
      }) as typeof globalThis.fetch
      return () => {
        globalThis.fetch = originalFetch
      }
    }

    it('does not fire suggestion when target altText.available is false', async () => {
      activateTargetWithAi(false, true)
      const suggestSpy = vi.fn()
      const restore = stubFetch(url => {
        if (url.includes('/suggest-alt')) {
          suggestSpy()
        }
        return new Response(null, { status: 404 })
      })
      try {
        const uploads = useAssetsUploadStore()
        uploads.configure({
          uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
        })
        mount(AssetUploadZone)
        uploads.enqueue(fakeFile('hero.jpg'), 'hero', null)
        await flushPromises()
        expect(suggestSpy).not.toHaveBeenCalled()
      } finally {
        restore()
      }
    })

    it('does not fire suggestion when altText.auto is false (review-first mode)', async () => {
      activateTargetWithAi(true, false)
      const suggestSpy = vi.fn()
      const restore = stubFetch(url => {
        if (url.includes('/suggest-alt')) suggestSpy()
        return new Response(null, { status: 404 })
      })
      try {
        const uploads = useAssetsUploadStore()
        uploads.configure({
          uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
        })
        mount(AssetUploadZone)
        uploads.enqueue(fakeFile('hero.jpg'), 'hero', null)
        await flushPromises()
        expect(suggestSpy).not.toHaveBeenCalled()
      } finally {
        restore()
      }
    })

    it('fires suggestion + populates the alt input on success', async () => {
      activateTargetWithAi(true, true)
      const restore = stubFetch(url => {
        if (url.includes('/suggest-alt')) {
          return new Response(JSON.stringify({ text: 'A cat on a windowsill', refused: false, refusalReason: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.includes('/assets/') && !url.includes('suggest-alt')) {
          // PATCH commit — return updated manifest.
          return new Response(JSON.stringify({ manifest: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(null, { status: 404 })
      })
      try {
        const uploads = useAssetsUploadStore()
        uploads.configure({
          uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
        })

        const wrapper = mount(AssetUploadZone)
        const id = uploads.enqueue(fakeFile('hero.jpg'), 'hero', null)
        await flushPromises()
        // Allow the AI fetch + PATCH commit to finish.
        await flushPromises()
        await flushPromises()

        const altInput = wrapper.find<HTMLInputElement>(`[data-testid="upload-${id}-alt-input"]`)
        expect(altInput.exists()).toBe(true)
        expect(altInput.element.value).toBe('A cat on a windowsill')
        expect(wrapper.find(`[data-testid="upload-${id}-ai-suggested"]`).exists()).toBe(true)
      } finally {
        restore()
      }
    })

    it('shows refusal hint and leaves alt input empty when model declines', async () => {
      activateTargetWithAi(true, true)
      const restore = stubFetch(url => {
        if (url.includes('/suggest-alt')) {
          return new Response(
            JSON.stringify({
              text: "I can't describe this image.",
              refused: true,
              refusalReason: "I can't describe this image.",
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(null, { status: 404 })
      })
      try {
        const uploads = useAssetsUploadStore()
        uploads.configure({
          uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
        })

        const wrapper = mount(AssetUploadZone)
        const id = uploads.enqueue(fakeFile('hero.jpg'), 'hero', null)
        await flushPromises()
        await flushPromises()

        const altInput = wrapper.find<HTMLInputElement>(`[data-testid="upload-${id}-alt-input"]`)
        expect(altInput.element.value).toBe('')
        expect(wrapper.find(`[data-testid="upload-${id}-ai-refused"]`).exists()).toBe(true)
      } finally {
        restore()
      }
    })

    it('does not fire for non-image uploads (PDF) even when AI is configured', async () => {
      activateTargetWithAi(true, true)
      const suggestSpy = vi.fn()
      const restore = stubFetch(url => {
        if (url.includes('/suggest-alt')) suggestSpy()
        return new Response(null, { status: 404 })
      })
      try {
        const uploads = useAssetsUploadStore()
        uploads.configure({
          uploadAsset: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
        })
        mount(AssetUploadZone)
        const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', {
          type: 'application/pdf',
        })
        uploads.enqueue(pdf, 'doc', null)
        await flushPromises()
        expect(suggestSpy).not.toHaveBeenCalled()
      } finally {
        restore()
      }
    })

    it('does not fire for locale-bytes uploads (only default uploads)', async () => {
      activateTargetWithAi(true, true)
      const suggestSpy = vi.fn()
      const restore = stubFetch(url => {
        if (url.includes('/suggest-alt')) suggestSpy()
        return new Response(null, { status: 404 })
      })
      try {
        const uploads = useAssetsUploadStore()
        uploads.configure({
          uploadLocaleBytes: vi.fn(async () => ({ manifest: {} as never, bytesPath: 'assets/x' })),
        })
        mount(AssetUploadZone)
        uploads.enqueueLocaleBytes(fakeFile('hero.jpg'), 'hero', { locale: 'fr' })
        await flushPromises()
        expect(suggestSpy).not.toHaveBeenCalled()
      } finally {
        restore()
      }
    })
  })
})
