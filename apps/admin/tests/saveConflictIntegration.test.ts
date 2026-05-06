/**
 * End-to-end integration test for Cut 9b: when the save flow's API
 * call throws StaleSaveError (server returned 409 STALE), the
 * editor:
 *
 *   - pushes the conflict into useSaveConflictsStore (keyed by
 *     manifest path)
 *   - updates useEditorEtagsStore with the server's currentEtag so
 *     the next save chains correctly
 *   - rethrows the error so the editor save flow surfaces failure
 *     to its caller
 *
 * We mock `api.updatePage` / `api.updateFragment` directly so this
 * test runs without a real server; the unit chain we care about
 * is `updateManifest` → store updates, which is exercised through
 * a save closure built by `useEditorActions` (the production seam).
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

describe('save conflict integration (Cut 9b)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('on 409 STALE: pushes to conflict store + updates etag store', async () => {
    // Pre-populate the etag store with a stale value the save flow
    // will try to send as If-Match.
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'stale-etag')

    // Stub updatePage to throw the documented 409 STALE shape.
    const updatePage = vi.spyOn(api, 'updatePage').mockImplementation(async () => {
      throw new StaleSaveError(
        { template: 'page-default', content: { title: 'Theirs' }, components: [] },
        'fresh-etag-x',
      )
    })

    // Simulate the editor focus on `pages/home` root.
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

    // Build the active target's save closure via useEditorActions →
    // ec.target.save. The simplest path: open a "_root" save context
    // by mocking `editorContent.target.save` with the closure shape
    // that buildSaveFn would produce. To stay in production paths,
    // we go through useEditorActions.openPageRoot → buildTarget,
    // but that needs a template-schema fetch. Cheapest: directly
    // instantiate the save closure path.
    //
    // Approach: build a synthetic EditingTarget save closure that
    // mirrors what buildTarget('root') produces — calls api.updatePage
    // through the etag-aware helper. We do that by invoking
    // useEditorActions().openPageRoot()? That requires lots of setup.
    //
    // Simpler: directly exercise the closure shape. The integration
    // we care about is: a save → api.updatePage that throws
    // StaleSaveError → conflict store populated. Use the editing
    // store's save indirectly by setting up an EditingTarget whose
    // save() calls api.updatePage with our If-Match.
    const ec = useEditorContentStore()
    const localeOpts = { locale: undefined, ifMatch: etags.get(path) ?? undefined }
    await ec.open({
      template: 'page-default',
      path: '_root',
      content: {},
      schema: {},
      save: async newContent => {
        try {
          const result = await api.updatePage('home', { content: newContent }, localeOpts)
          if (result.etag) etags.set(path, result.etag)
        } catch (err) {
          if (err instanceof StaleSaveError) {
            useSaveConflictsStore().set({
              itemPath: path,
              current: err.current,
              currentEtag: err.currentEtag,
              pending: { template: 'page-default', content: newContent, components: [] },
            })
            etags.set(path, err.currentEtag)
          }
          throw err
        }
      },
    })

    // Trigger the save closure; expect it to throw the StaleSaveError.
    await expect(ec.target!.save({ title: 'Mine' })).rejects.toThrow(StaleSaveError)

    // Confirm the side effects landed.
    const conflicts = useSaveConflictsStore()
    expect(conflicts.has(path)).toBe(true)
    const record = conflicts.get(path)!
    expect(record.currentEtag).toBe('fresh-etag-x')
    expect((record.current.content as { title: string }).title).toBe('Theirs')
    expect((record.pending.content as { title: string }).title).toBe('Mine')

    // Etag store updated to the server's fresh etag — chain projection
    // works on the next save attempt.
    expect(etags.get(path)).toBe('fresh-etag-x')

    // updatePage was called with the stale If-Match the author had.
    expect(updatePage).toHaveBeenCalledTimes(1)
    expect(updatePage.mock.calls[0][2]).toMatchObject({ ifMatch: 'stale-etag' })
  })

  it('on success: updates etag store from response.etag for chain projection', async () => {
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'baseline-etag')

    vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'projected-etag' })

    const ec = useEditorContentStore()
    await ec.open({
      template: 'page-default',
      path: '_root',
      content: {},
      schema: {},
      save: async newContent => {
        const result = await api.updatePage(
          'home',
          { content: newContent },
          {
            ifMatch: etags.get(path) ?? undefined,
          },
        )
        if (result.etag) etags.set(path, result.etag)
      },
    })

    await ec.target!.save({ title: 'New' })

    // Etag store advanced to the server's projected value.
    expect(etags.get(path)).toBe('projected-etag')
    // No conflict since save succeeded.
    expect(useSaveConflictsStore().hasAny).toBe(false)
  })

  it('via useEditorActions: real save flow sends If-Match + handles 409 STALE', async () => {
    // Production-path test: build an EditingTarget through the actual
    // useEditorActions surface and verify the save closure plumbed
    // by buildTarget invokes the etag-aware helper. Selection store
    // pre-loaded with a synthetic page detail so buildTarget('root')
    // can produce a target without a real fetch.
    const etags = useEditorEtagsStore()
    const path = manifestPath('page', 'home')
    etags.set(path, 'baseline-etag')

    // Stub schema fetch (buildTarget calls api.getTemplateSchema).
    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
      properties: { title: { type: 'string' } },
    })
    // Stub updatePage to throw 409 STALE.
    const updatePage = vi.spyOn(api, 'updatePage').mockImplementation(async () => {
      throw new StaleSaveError(
        { template: 'page-default', content: { title: 'Theirs' }, components: [] },
        'fresh-from-server',
      )
    })

    // Selection store needs a `selection` for buildTarget('root') to
    // resolve.
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

    const actions = useEditorActions()
    await actions.openPageRoot()

    // Now the editor's active target carries a save closure that
    // routes through updateManifest. Trigger it:
    const ec = useEditorContentStore()
    expect(ec.target).not.toBeNull()
    await expect(ec.target!.save({ title: 'Mine' })).rejects.toThrow(StaleSaveError)

    // The save closure must have sent the stale If-Match.
    expect(updatePage).toHaveBeenCalled()
    const callOpts = updatePage.mock.calls[0][2]
    expect(callOpts).toMatchObject({ ifMatch: 'baseline-etag' })

    // Conflict store populated.
    const conflicts = useSaveConflictsStore()
    expect(conflicts.has(path)).toBe(true)
    const record = conflicts.get(path)!
    expect(record.currentEtag).toBe('fresh-from-server')
    expect((record.current.content as { title: string }).title).toBe('Theirs')
    expect((record.pending.content as { title: string }).title).toBe('Mine')

    // Etag store updated to the fresh server etag for chain projection.
    expect(etags.get(path)).toBe('fresh-from-server')
  })
})
