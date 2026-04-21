import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AssetUploadZone from '../src/client/components/AssetUploadZone.vue'
import { useAssetsUploadStore } from '../src/client/stores/assetsUpload.js'

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
})
