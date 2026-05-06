/**
 * Cut 13 — mid-save connection-loss reconcile per
 * `design-offline.md` Q4 "handled invisibly."
 *
 * When the PUT throws a network error (TypeError from fetch), the
 * client doesn't know whether the save landed before the drop.
 * `updateManifest` reconciles via a single GET-and-compare:
 *
 *   - Server's current matches what the author tried to save →
 *     silent success; etag advances; editor goes clean
 *   - Server's current differs → StaleSaveError; conflict UX takes
 *     over (banner + diff view from Cut 10)
 *   - GET also fails → original network error propagates; editor
 *     stays dirty so the author can retry manually
 *
 * Tests exercise the seam through the editor save closure built by
 * useEditorActions (production path). api.updatePage is stubbed to
 * throw TypeError; api.getPageWithEtag is stubbed to return
 * various server states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { StaleSaveError, api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useEditorEtagsStore, manifestPath } from '../src/client/stores/editorEtags.js'
import { useSaveConflictsStore } from '../src/client/stores/saveConflicts.js'

afterEach(() => vi.restoreAllMocks())

beforeEach(() => setActivePinia(createPinia()))

function seedRootSelection() {
  const sel = useSelectionStore()
  sel.$patch({
    selection: {
      type: 'page',
      name: 'home',
      detail: {
        name: 'home',
        route: '/',
        template: 'page-default',
        content: {},
        components: [],
        dir: 'pages/home',
      },
    },
  })
}

describe('mid-save connection-loss reconcile', () => {
  it('silently succeeds when server.current === pending (case a: save landed, response lost)', async () => {
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'baseline-etag')

    // Stub schema fetch (buildTarget calls api.getTemplateSchema).
    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
      properties: { title: { type: 'string' } },
    })
    // Stub PUT to fail with TypeError (network drop).
    vi.spyOn(api, 'updatePage').mockRejectedValue(new TypeError('Failed to fetch'))
    // Stub GET to return what the author tried to save — case (a):
    // the server received + applied the save; only the response was lost.
    const getSpy = vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({
      data: {
        name: 'home',
        route: '/',
        template: 'page-default',
        content: { title: 'My Edit' },
        components: [],
        dir: 'pages/home',
      },
      etag: 'post-save-etag',
    })

    seedRootSelection()
    const actions = useEditorActions()
    await actions.openPageRoot()

    // Trigger the save closure with the same content the GET will
    // report — simulates the case where the save landed.
    const ec = useEditorContentStore()
    await ec.target!.save({ title: 'My Edit' })

    // Reconcile must have happened: GET was called, etag advanced.
    expect(getSpy).toHaveBeenCalledOnce()
    expect(etags.get(path)).toBe('post-save-etag')
    // No conflict surfaced (silent success).
    expect(useSaveConflictsStore().hasAny).toBe(false)
  })

  it('surfaces StaleSaveError when server.current differs from pending (case b: save did not land OR concurrent third-party save)', async () => {
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'baseline-etag')

    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
      properties: { title: { type: 'string' } },
    })
    vi.spyOn(api, 'updatePage').mockRejectedValue(new TypeError('Failed to fetch'))
    // GET returns the pre-save state — server didn't receive the save.
    vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({
      data: {
        name: 'home',
        route: '/',
        template: 'page-default',
        content: { title: 'Untouched' },
        components: [],
        dir: 'pages/home',
      },
      etag: 'unchanged-etag',
    })

    seedRootSelection()
    const actions = useEditorActions()
    await actions.openPageRoot()

    const ec = useEditorContentStore()
    await expect(ec.target!.save({ title: 'My Edit' })).rejects.toThrow(StaleSaveError)

    // Conflict surfaced via the existing flow (Cut 10).
    const conflicts = useSaveConflictsStore()
    expect(conflicts.has(path)).toBe(true)
    const record = conflicts.get(path)!
    expect((record.current.content as { title: string }).title).toBe('Untouched')
    expect(record.currentEtag).toBe('unchanged-etag')
    expect((record.pending.content as { title: string }).title).toBe('My Edit')
    // Etag store advanced to the server's etag for the next save.
    expect(etags.get(path)).toBe('unchanged-etag')
  })

  it('propagates the original network error when GET also fails', async () => {
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'baseline-etag')

    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
      properties: { title: { type: 'string' } },
    })
    vi.spyOn(api, 'updatePage').mockRejectedValue(new TypeError('Failed to fetch'))
    // GET also fails — no reconcile possible.
    vi.spyOn(api, 'getPageWithEtag').mockRejectedValue(new TypeError('Failed to fetch'))

    seedRootSelection()
    const actions = useEditorActions()
    await actions.openPageRoot()

    const ec = useEditorContentStore()
    await expect(ec.target!.save({ title: 'My Edit' })).rejects.toThrow(TypeError)

    // No conflict surfaced (we don't know what the server has).
    expect(useSaveConflictsStore().hasAny).toBe(false)
    // Etag store unchanged — the author's pending edits stay dirty
    // and they can retry when connection comes back.
    expect(etags.get(path)).toBe('baseline-etag')
  })

  it('does NOT reconcile on HTTP errors (only on TypeError network failures)', async () => {
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'baseline-etag')

    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
      properties: { title: { type: 'string' } },
    })
    // Stub PUT with a regular Error (e.g., 500 from the server) —
    // not ambiguous; the server told us it failed.
    vi.spyOn(api, 'updatePage').mockRejectedValue(new Error('Request failed: 500'))
    const getSpy = vi.spyOn(api, 'getPageWithEtag')

    seedRootSelection()
    const actions = useEditorActions()
    await actions.openPageRoot()

    const ec = useEditorContentStore()
    await expect(ec.target!.save({ title: 'My Edit' })).rejects.toThrow('Request failed: 500')

    // No reconcile attempt — GET wasn't called.
    expect(getSpy).not.toHaveBeenCalled()
    // No conflict surfaced.
    expect(useSaveConflictsStore().hasAny).toBe(false)
  })

  it('still surfaces 409 STALE on PUT directly (no reconcile path; the original conflict flow takes over)', async () => {
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'stale-etag')

    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
      properties: { title: { type: 'string' } },
    })
    // Stub PUT to throw a normal StaleSaveError (server sent 409).
    vi.spyOn(api, 'updatePage').mockRejectedValue(
      new StaleSaveError({ template: 'page-default', content: { title: 'Theirs' }, components: [] }, 'fresh-etag'),
    )
    const getSpy = vi.spyOn(api, 'getPageWithEtag')

    seedRootSelection()
    const actions = useEditorActions()
    await actions.openPageRoot()

    const ec = useEditorContentStore()
    await expect(ec.target!.save({ title: 'Mine' })).rejects.toThrow(StaleSaveError)

    // GET wasn't called — the 409 already had the server state.
    expect(getSpy).not.toHaveBeenCalled()
    // Standard conflict flow surfaced.
    expect(useSaveConflictsStore().has(path)).toBe(true)
  })
})
