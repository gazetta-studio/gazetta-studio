/**
 * Replace file in the asset detail pane (design-media.md "Replace (cut 1, M3)"):
 * the component's states, and the `useAssetReplace` flow that drives them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AssetSummary } from 'gazetta/schema'
import AssetReplaceButton from '../src/client/components/AssetReplaceButton.vue'
import AssetDetail from '../src/client/components/AssetDetail.vue'
import { useAssetReplace, type ReplaceState } from '../src/client/composables/useAssetReplace.js'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsSelectionStore } from '../src/client/stores/assetsSelection.js'

function summary(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    name: 'hero',
    kind: 'embedded',
    mime: 'image/png',
    size: 1000,
    hash: 'bbbbbbbb',
    width: 120,
    height: 80,
    alt: 'Sunset over the bay',
    focalPoint: { x: 0.2, y: 0.7 },
    uploadedAt: '2026-10-30T09:00:00Z',
    overrideLocales: [],
    overrideThemes: [],
    ...overrides,
  }
}

function render(state: ReplaceState, aiAvailable = true) {
  return mount(AssetReplaceButton, { props: { assetName: 'hero', assetMime: 'image/jpeg', state, aiAvailable } })
}

const done = (perUseAltCount: number): ReplaceState => ({ kind: 'done', asset: summary(), perUseAltCount })

function respond(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )
}

const png = () => new File([new Uint8Array([1, 2, 3])], 'new.png', { type: 'image/png' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AssetReplaceButton states', () => {
  it.each<[string, ReplaceState, string, string]>([
    [
      'wrong kind',
      { kind: 'wrong-kind', fileCategory: 'audio' },
      'replace-kind-error',
      'This file is audio; hero is an image. Choose an image.',
    ],
    ['working', { kind: 'working' }, 'replace-progress', 'Replacing hero…'],
    [
      'failed',
      { kind: 'failed', reason: 'disk full' },
      'replace-error',
      "Couldn't replace hero: disk full. Nothing changed.",
    ],
    ['done', done(0), 'replace-note', 'Check the alt text and focal point still fit the new image.'],
  ])('%s shows its message', (_label, state, testid, text) => {
    const wrapper = render(state)
    expect(wrapper.find(`[data-testid="${testid}"]`).text()).toContain(text)
    expect(wrapper.find('[data-testid="asset-replace"]').attributes('data-state')).toBe(state.kind)
  })

  it('idle shows only the button, and the chooser offers the asset’s kind', () => {
    const wrapper = render({ kind: 'idle' })
    expect(wrapper.find('[data-testid="asset-detail-replace"]').text()).toBe('Replace file')
    expect(wrapper.find('[data-testid="asset-detail-replace-input"]').attributes('accept')).toBe('image/*')
    for (const id of ['replace-kind-error', 'replace-progress', 'replace-error', 'replace-note']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
    }
  })

  it('working disables the button', () => {
    expect(
      render({ kind: 'working' }).find('[data-testid="asset-detail-replace"]').attributes('disabled'),
    ).toBeDefined()
  })

  it('done shows the new image with its alt and focal point', () => {
    const wrapper = render(done(0))
    const img = wrapper.find('[data-testid="replace-note"] img')
    expect(img.attributes('src')).toBe('/assets/hero-bbbbbbbb.png')
    expect(img.attributes('alt')).toBe('Sunset over the bay')
    expect(wrapper.find('[data-testid="replace-note"]').text()).toContain('20% × 70%')
  })

  it.each([
    [true, true],
    [false, false],
  ])('Suggest shows when AI alt is available (%s)', (ai, shown) => {
    expect(render(done(0), ai).find('[data-testid="replace-note-suggest"]').exists()).toBe(shown)
  })

  it.each([
    [0, null],
    [1, 'Used on 1 pages and fragments with their own alt text.'],
    [3, 'Used on 3 pages and fragments with their own alt text.'],
  ])('the per-use line for %i uses', (count, text) => {
    const line = render(done(count)).find('[data-testid="replace-note-per-use"]')
    expect(line.exists() ? line.text() : null).toBe(text)
  })

  it.each([
    ['replace-note-edit-alt', 'editAlt'],
    ['replace-note-edit-focal', 'editFocal'],
    ['replace-note-suggest', 'suggest'],
    ['replace-note-dismiss', 'dismiss'],
  ])('%s emits %s', async (testid, event) => {
    const wrapper = render(done(1))
    await wrapper.find(`[data-testid="${testid}"]`).trigger('click')
    expect(wrapper.emitted(event)).toHaveLength(1)
  })

  it('choosing a file emits it', async () => {
    const wrapper = render({ kind: 'idle' })
    const input = wrapper.find('[data-testid="asset-detail-replace-input"]')
    const file = png()
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')
    expect(wrapper.emitted('choose')?.[0]).toEqual([file])
  })
})

describe('useAssetReplace', () => {
  it('sends the file and, on success, shows the note and reports the new asset', async () => {
    const fetch = respond(200, { manifest: summary(), perUseAltCount: 2 })
    vi.stubGlobal('fetch', fetch)
    const onReplaced = vi.fn()
    const replace = useAssetReplace(onReplaced)

    await replace.choose(summary({ mime: 'image/jpeg', hash: 'aaaaaaaa' }), png())

    expect(String(fetch.mock.calls[0]![0])).toContain('/assets/hero/replace-file')
    expect(replace.state.value).toEqual({ kind: 'done', asset: summary(), perUseAltCount: 2 })
    expect(onReplaced).toHaveBeenCalledWith(summary())
  })

  it('refuses a file of another kind before sending it', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const replace = useAssetReplace(vi.fn())

    await replace.choose(summary(), new File([new Uint8Array([1])], 'a.mp3', { type: 'audio/mpeg' }))

    expect(fetch).not.toHaveBeenCalled()
    expect(replace.state.value).toEqual({ kind: 'wrong-kind', fileCategory: 'audio' })
  })

  it('shows the server’s kind refusal as wrong kind', async () => {
    vi.stubGlobal(
      'fetch',
      respond(409, {
        code: 'ASSET_KIND_MISMATCH',
        oldKind: 'embedded',
        oldMimeCategory: 'image',
        newKind: 'embedded',
        newMimeCategory: 'audio',
      }),
    )
    const onReplaced = vi.fn()
    const replace = useAssetReplace(onReplaced)

    await replace.choose(summary(), new File([new Uint8Array([1])], 'x', { type: '' }))

    expect(replace.state.value).toEqual({ kind: 'wrong-kind', fileCategory: 'audio' })
    expect(onReplaced).not.toHaveBeenCalled()
  })

  it('a hook’s refusal shows its reason, not a kind mismatch', async () => {
    vi.stubGlobal('fetch', respond(409, { code: 'HOOK_CANCELLED', detail: 'Uploads are frozen' }))
    const onReplaced = vi.fn()
    const replace = useAssetReplace(onReplaced)

    await replace.choose(summary(), png())

    expect(replace.state.value).toEqual({ kind: 'failed', reason: 'Uploads are frozen' })
    expect(onReplaced).not.toHaveBeenCalled()
  })

  it('a failure shows the reason and reports nothing, so the old preview stays', async () => {
    vi.stubGlobal('fetch', respond(500, { code: 'ASSET_STORAGE_FAILURE', detail: 'disk full' }))
    const onReplaced = vi.fn()
    const replace = useAssetReplace(onReplaced)

    await replace.choose(summary(), png())

    expect(replace.state.value).toEqual({ kind: 'failed', reason: 'disk full' })
    expect(onReplaced).not.toHaveBeenCalled()
  })

  it('dismiss clears the note', async () => {
    vi.stubGlobal('fetch', respond(200, { manifest: summary(), perUseAltCount: 0 }))
    const replace = useAssetReplace(vi.fn())
    await replace.choose(summary(), png())

    replace.dismiss()

    expect(replace.state.value).toEqual({ kind: 'idle' })
  })
})

describe('Replace file in AssetDetail', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps the old preview when the replace fails, and Dismiss removes the note after a success', async () => {
    const list = useAssetsListStore()
    list.assets = [summary({ mime: 'image/jpeg', hash: 'aaaaaaaa' })]
    useAssetsSelectionStore().select('hero')
    const wrapper = mount(AssetDetail)
    const choose = async () => {
      const input = wrapper.find('[data-testid="asset-detail-replace-input"]')
      Object.defineProperty(input.element, 'files', { value: [png()], configurable: true })
      await input.trigger('change')
      await flushPromises()
    }

    vi.stubGlobal('fetch', respond(500, { code: 'ASSET_STORAGE_FAILURE', detail: 'disk full' }))
    await choose()
    expect(wrapper.find('[data-testid="replace-error"]').exists()).toBe(true)
    expect(wrapper.find('.asset-detail-preview img').attributes('src')).toBe('/assets/hero-aaaaaaaa.jpg')

    vi.stubGlobal('fetch', respond(200, { manifest: summary(), perUseAltCount: 0 }))
    list.refresh = vi.fn(async () => {})
    await choose()
    expect(list.refresh).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="replace-note"]').exists()).toBe(true)

    await wrapper.find('[data-testid="replace-note-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="replace-note"]').exists()).toBe(false)
  })
})
