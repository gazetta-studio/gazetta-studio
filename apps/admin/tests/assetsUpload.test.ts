import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAssetsUploadStore } from '../src/client/stores/assetsUpload.js'
import type { UploadedAsset } from '../src/client/api/client.js'

function sampleResult(overrides: Partial<UploadedAsset['manifest']> = {}): UploadedAsset {
  return {
    manifest: {
      version: 1,
      name: 'uploaded',
      kind: 'embedded',
      source: 'internal',
      mime: 'image/jpeg',
      size: 1000,
      hash: 'aaaaaaaa',
      width: 100,
      height: 100,
      alt: null,
      uploadedAt: '2026-04-22T00:00:00.000Z',
      uploadedBy: '',
      ...overrides,
    },
    bytesPath: 'assets/uploaded-aaaaaaaa.jpg',
  }
}

function fakeFile(name: string): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('assetsUpload store', () => {
  it('starts empty with no active uploads', () => {
    const store = useAssetsUploadStore()
    expect(store.uploads).toEqual([])
    expect(store.hasActive).toBe(false)
    expect(store.hasErrors).toBe(false)
  })

  it('enqueue adds a queued entry and returns its id', () => {
    const store = useAssetsUploadStore()
    store.configure({ uploadAsset: vi.fn(async () => sampleResult()) })

    const id = store.enqueue(fakeFile('a.jpg'), 'a', null)

    expect(typeof id).toBe('string')
    expect(id).toMatch(/^u-/)
    expect(store.uploads).toHaveLength(1)
    expect(store.uploads[0].id).toBe(id)
    expect(store.uploads[0].name).toBe('a')
  })

  it('single upload transitions queued → uploading → success', async () => {
    const store = useAssetsUploadStore()
    let resolveUpload: ((v: UploadedAsset) => void) | null = null
    const uploadPromise = new Promise<UploadedAsset>(r => {
      resolveUpload = r
    })
    store.configure({ uploadAsset: () => uploadPromise })

    const id = store.enqueue(fakeFile('a.jpg'), 'a', null)

    // Let the drainQueue microtask run so it picks up the queued entry.
    await Promise.resolve()
    expect(store.uploads[0].status).toBe('uploading')

    resolveUpload!(sampleResult())
    await new Promise(r => setTimeout(r, 0))

    const entry = store.uploads.find(u => u.id === id)
    expect(entry?.status).toBe('success')
    expect(entry?.bytesPath).toBe('assets/uploaded-aaaaaaaa.jpg')
  })

  it('failed upload sets status=error with code + message', async () => {
    const store = useAssetsUploadStore()
    const err = new Error('MIME not allowed') as Error & { code: string }
    err.code = 'ASSET_MIME_MISMATCH'
    store.configure({
      uploadAsset: async () => {
        throw err
      },
    })

    const id = store.enqueue(fakeFile('a.webp'), 'a', null)
    await new Promise(r => setTimeout(r, 0))

    const entry = store.uploads.find(u => u.id === id)
    expect(entry?.status).toBe('error')
    expect(entry?.errorCode).toBe('ASSET_MIME_MISMATCH')
    expect(entry?.errorMessage).toBe('MIME not allowed')
    expect(store.hasErrors).toBe(true)
  })

  it('processes queue serially — second file waits for first to finish', async () => {
    const store = useAssetsUploadStore()
    const started: string[] = []
    let releaseFirst: (() => void) | null = null
    const firstDone = new Promise<void>(r => {
      releaseFirst = r
    })

    store.configure({
      uploadAsset: async (_f, name) => {
        started.push(name)
        if (name === 'first') await firstDone
        return sampleResult({ name })
      },
    })

    store.enqueue(fakeFile('1.jpg'), 'first', null)
    store.enqueue(fakeFile('2.jpg'), 'second', null)

    // Microtask: drainQueue starts 'first'
    await Promise.resolve()
    expect(started).toEqual(['first'])
    expect(store.uploads[1].status).toBe('queued')

    releaseFirst!()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(started).toEqual(['first', 'second'])
  })

  it('clearSuccesses removes completed entries only', async () => {
    const store = useAssetsUploadStore()
    store.configure({ uploadAsset: async (_, name) => sampleResult({ name }) })

    store.enqueue(fakeFile('a.jpg'), 'a', null)
    store.enqueue(fakeFile('b.jpg'), 'b', null)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    store.clearSuccesses()
    expect(store.uploads).toEqual([])
  })

  it('clearErrors removes error entries only', async () => {
    const store = useAssetsUploadStore()
    store.configure({
      uploadAsset: async () => {
        throw new Error('boom')
      },
    })

    store.enqueue(fakeFile('a.jpg'), 'a', null)
    await new Promise(r => setTimeout(r, 0))

    expect(store.uploads[0].status).toBe('error')
    store.clearErrors()
    expect(store.uploads).toEqual([])
  })

  it('hasActive is true while an upload is in flight', async () => {
    const store = useAssetsUploadStore()
    let release: (() => void) | null = null
    const hang = new Promise<void>(r => {
      release = r
    })
    store.configure({
      uploadAsset: async () => {
        await hang
        return sampleResult()
      },
    })

    store.enqueue(fakeFile('a.jpg'), 'a', null)
    await Promise.resolve()
    expect(store.hasActive).toBe(true)

    release!()
    await new Promise(r => setTimeout(r, 0))
    expect(store.hasActive).toBe(false)
  })
})
