/**
 * Tests for `useConflictDiscard` — the orchestrator the editor's
 * ConflictBanner calls when the author clicks "Discard my changes."
 *
 * Three side effects must fire in order per `design-offline.md` Q3:
 *
 *   1. `conflicts.clear(itemPath)` — banner closes
 *   2. `editing.discard()` — editor reverts to saved baseline
 *   3. `selection.reload()` — fresh manifest + etag from server
 *
 * Production path: ConflictBanner emits `@discard` → EditorPanel
 * calls `conflictDiscard.run(activeManifestPath)`. Tests construct
 * a fresh Pinia + spy on the three side effects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConflictDiscard } from '../src/client/composables/useConflictDiscard.js'
import { useSaveConflictsStore } from '../src/client/stores/saveConflicts.js'

beforeEach(() => setActivePinia(createPinia()))

describe('useConflictDiscard', () => {
  it('clears the conflict for the given itemPath', async () => {
    const conflicts = useSaveConflictsStore()
    conflicts.set({
      itemPath: 'pages/home/page.json',
      current: { template: 'page-default' },
      currentEtag: 'fresh',
      pending: { template: 'page-default' },
    })
    expect(conflicts.has('pages/home/page.json')).toBe(true)

    const discard = useConflictDiscard()
    await discard.run('pages/home/page.json')

    expect(conflicts.has('pages/home/page.json')).toBe(false)
  })

  it('does not clear conflicts on OTHER paths', async () => {
    const conflicts = useSaveConflictsStore()
    conflicts.set({
      itemPath: 'pages/home/page.json',
      current: {},
      currentEtag: 'a',
      pending: {},
    })
    conflicts.set({
      itemPath: 'pages/about/page.json',
      current: {},
      currentEtag: 'b',
      pending: {},
    })

    const discard = useConflictDiscard()
    await discard.run('pages/home/page.json')

    expect(conflicts.has('pages/home/page.json')).toBe(false)
    expect(conflicts.has('pages/about/page.json')).toBe(true)
  })

  it('drops local pending edits via editing.discard', async () => {
    // Mount the orchestrator. We stub the editing + selection
    // methods that get called so we can assert ordering without
    // standing up the full editor stack.
    const { useEditingStore } = await import('../src/client/stores/editing.js')
    const { useSelectionStore } = await import('../src/client/stores/selection.js')

    const editing = useEditingStore()
    const selection = useSelectionStore()

    const discardSpy = vi.spyOn(editing, 'discard').mockImplementation(() => {})
    const reloadSpy = vi.spyOn(selection, 'reload').mockResolvedValue()

    const discard = useConflictDiscard()
    await discard.run('pages/home/page.json')

    expect(discardSpy).toHaveBeenCalledOnce()
    expect(reloadSpy).toHaveBeenCalledOnce()
  })

  it('orders side effects: clear → discard → reload', async () => {
    const { useEditingStore } = await import('../src/client/stores/editing.js')
    const { useSelectionStore } = await import('../src/client/stores/selection.js')

    const conflicts = useSaveConflictsStore()
    conflicts.set({
      itemPath: 'pages/home/page.json',
      current: {},
      currentEtag: 'fresh',
      pending: {},
    })

    const editing = useEditingStore()
    const selection = useSelectionStore()

    const order: string[] = []
    const clearSpy = vi.spyOn(conflicts, 'clear').mockImplementation(() => {
      order.push('clear')
    })
    vi.spyOn(editing, 'discard').mockImplementation(() => {
      order.push('discard')
    })
    vi.spyOn(selection, 'reload').mockImplementation(async () => {
      order.push('reload')
    })

    const discard = useConflictDiscard()
    await discard.run('pages/home/page.json')

    expect(order).toEqual(['clear', 'discard', 'reload'])
    expect(clearSpy).toHaveBeenCalledWith('pages/home/page.json')
  })

  it('awaits selection.reload before resolving', async () => {
    // The reload is async — fetches the manifest + etag from the
    // server. The composable must await it so callers know "all
    // side effects are done" when the promise resolves.
    const { useSelectionStore } = await import('../src/client/stores/selection.js')
    const selection = useSelectionStore()

    let reloadResolved = false
    vi.spyOn(selection, 'reload').mockImplementation(async () => {
      // Simulate server round-trip latency.
      await new Promise(resolve => setTimeout(resolve, 10))
      reloadResolved = true
    })

    const discard = useConflictDiscard()
    await discard.run('pages/home/page.json')

    // After awaiting run(), reload MUST have completed.
    expect(reloadResolved).toBe(true)
  })

  it('idempotent on a path with no active conflict', async () => {
    // Author clicks Discard, then clicks again rapidly (or two
    // banners somehow racing) — the second call should not throw
    // even though there's no conflict to clear. The other side
    // effects (discard + reload) are also safe to repeat.
    const { useEditingStore } = await import('../src/client/stores/editing.js')
    const { useSelectionStore } = await import('../src/client/stores/selection.js')

    const editing = useEditingStore()
    const selection = useSelectionStore()
    vi.spyOn(editing, 'discard').mockImplementation(() => {})
    vi.spyOn(selection, 'reload').mockResolvedValue()

    const discard = useConflictDiscard()
    // No conflict in the store — clear() is a no-op.
    await expect(discard.run('pages/home/page.json')).resolves.toBeUndefined()
  })

  it('propagates selection.reload failures', async () => {
    // If the reload fails (network error, server 500), the discard
    // flow must surface it so the caller can show an error toast.
    // Conflict + editing.discard already fired — that's expected:
    // the author chose to discard, we did so, only the reload
    // failed; the editor will retry on the next navigation.
    const { useEditingStore } = await import('../src/client/stores/editing.js')
    const { useSelectionStore } = await import('../src/client/stores/selection.js')

    const conflicts = useSaveConflictsStore()
    conflicts.set({
      itemPath: 'pages/home/page.json',
      current: {},
      currentEtag: 'fresh',
      pending: {},
    })

    const editing = useEditingStore()
    const selection = useSelectionStore()
    vi.spyOn(editing, 'discard').mockImplementation(() => {})
    vi.spyOn(selection, 'reload').mockRejectedValue(new Error('reload failed'))

    const discard = useConflictDiscard()
    await expect(discard.run('pages/home/page.json')).rejects.toThrow('reload failed')

    // Conflict was cleared BEFORE the reload threw — banner closes
    // even on partial-failure.
    expect(conflicts.has('pages/home/page.json')).toBe(false)
  })
})
