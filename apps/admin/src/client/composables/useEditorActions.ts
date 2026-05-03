function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

import { computed } from 'vue'
import type { DraftOverrides, ManifestKey } from 'gazetta/types'
import { manifestKeyFromString } from 'gazetta/types'
import { useToastStore } from '../stores/toast.js'
import { usePreviewStore } from '../stores/preview.js'
import { useSelectionStore } from '../stores/selection.js'
import { usePublishStatusStore } from '../stores/publishStatus.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useSiteStore } from '../stores/site.js'
import { useEditorStashStore } from '../stores/editorStash.js'
import { useEditorStructuralStore } from '../stores/editorStructural.js'
import { useEditorPersistenceStore, type StructuralWrite } from '../stores/editorPersistence.js'
import { useEditorContentStore, type EditingTarget } from '../stores/editorContent.js'
import { type EditorSelection, selectionToStashKey, selectionToErrorLabel } from './editorSelection.js'
import { api } from '../api/client.js'
import { useLocaleStore } from '../stores/locale.js'

const MAX_RETRY_ATTEMPTS = 3
const BASE_RETRY_DELAY = 3000

/**
 * Editor action mediator — one entry point for all editor navigation.
 *
 * All component opens go through `navigate(sel)`. It handles stash,
 * abort, fetch, open, retry — in one place. The AbortController cancels
 * pending fetches when a new navigation starts, matching the pattern
 * already used in selection.ts for page/fragment loading.
 */
export function useEditorActions() {
  const toast = useToastStore()
  const stash = useEditorStashStore()
  const structural = useEditorStructuralStore()
  const persistence = useEditorPersistenceStore()
  const ec = useEditorContentStore()

  // --- Navigation state ---

  let navController: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0

  function cancelPending() {
    navController?.abort()
    navController = null
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    retryAttempt = 0
  }

  // --- Stash ---

  function stashCurrent() {
    if (ec.dirty && ec.target && ec.content) {
      stash.stash(ec.target.path, ec.target, deepClone(ec.content))
    }
  }

  // --- Schema + component lookup ---

  async function fetchSchema(templateName: string, signal: AbortSignal) {
    const response = await api.getTemplateSchema(templateName, { signal })
    const { hasEditor, editorUrl, fieldsBaseUrl, ...schema } = response as Record<string, unknown> & {
      hasEditor?: boolean
      editorUrl?: string
      fieldsBaseUrl?: string
    }
    return { schema, hasEditor: !!hasEditor, editorUrl, fieldsBaseUrl }
  }

  function resolveComponentPath(namePath: string): string {
    const sel = useSelectionStore()
    if (sel.type === 'fragment' && sel.name && namePath.startsWith(`@${sel.name}/`)) {
      return namePath.slice(`@${sel.name}/`.length)
    }
    return namePath
  }

  function findComponentByNamePath(namePath: string): { template: string; content: Record<string, unknown> } | null {
    const sel = useSelectionStore()
    const detail = sel.detail
    if (!detail?.components) return null

    const parts = resolveComponentPath(namePath).split('/')
    let components = detail.components as Array<
      string | { name: string; template: string; content?: Record<string, unknown>; components?: unknown[] }
    >

    for (let i = 0; i < parts.length; i++) {
      const comp = components.find(c => typeof c === 'object' && c.name === parts[i])
      if (!comp || typeof comp === 'string') return null
      if (i === parts.length - 1)
        return { template: comp.template, content: (comp.content as Record<string, unknown>) ?? {} }
      components = (comp.components ?? []) as typeof components
    }
    return null
  }

  function buildSaveFn(namePath: string): (content: Record<string, unknown>) => Promise<void> {
    return async (newContent: Record<string, unknown>) => {
      const sel = useSelectionStore()
      const detail = sel.detail
      if (!detail || !sel.selection) return

      const updatedComponents = deepClone(detail.components ?? [])
      const parts = resolveComponentPath(namePath).split('/')
      let components = updatedComponents as Array<
        string | { name: string; template: string; content?: Record<string, unknown>; components?: unknown[] }
      >

      for (let i = 0; i < parts.length; i++) {
        const idx = components.findIndex(c => typeof c === 'object' && c.name === parts[i])
        if (idx === -1) return
        const comp = components[idx] as {
          name: string
          template: string
          content?: Record<string, unknown>
          components?: unknown[]
        }
        if (i === parts.length - 1) {
          comp.content = newContent
        } else {
          components = (comp.components ?? []) as typeof components
        }
      }

      const localeOpts = { locale: useLocaleStore().effectiveLocale ?? undefined }
      if (sel.selection.type === 'page') {
        await api.updatePage(sel.selection.name, { components: updatedComponents }, localeOpts)
      } else {
        await api.updateFragment(sel.selection.name, { components: updatedComponents }, localeOpts)
      }
    }
  }

  // --- Build an EditingTarget from a selection ---

  async function buildTarget(sel: EditorSelection, signal: AbortSignal): Promise<EditingTarget> {
    const selStore = useSelectionStore()
    switch (sel.kind) {
      case 'root': {
        const d = selStore.detail
        const selection = selStore.selection
        if (!d || !selection) throw new Error('No page/fragment selected')
        const pageContent = (d.content as Record<string, unknown>) ?? {}
        const { schema, hasEditor, editorUrl, fieldsBaseUrl } = await fetchSchema(d.template, signal)
        const saveFn =
          selection.type === 'page'
            ? (c: Record<string, unknown>) =>
                api
                  .updatePage(selection.name, { content: c }, { locale: useLocaleStore().effectiveLocale ?? undefined })
                  .then(() => {})
            : (c: Record<string, unknown>) =>
                api
                  .updateFragment(
                    selection.name,
                    { content: c },
                    { locale: useLocaleStore().effectiveLocale ?? undefined },
                  )
                  .then(() => {})
        return {
          template: d.template,
          path: '_root',
          content: pageContent,
          schema,
          hasEditor,
          editorUrl,
          fieldsBaseUrl,
          save: saveFn,
        }
      }
      case 'component': {
        const comp = findComponentByNamePath(sel.path)
        if (!comp) throw new Error(`Component "${sel.path}" not found in page manifest`)
        // Use template from the manifest — sel.template may be empty when restoring from URL hash
        const templateName = sel.template || comp.template
        const { schema, hasEditor, editorUrl, fieldsBaseUrl } = await fetchSchema(templateName, signal)
        return {
          template: templateName,
          path: sel.path,
          content: comp.content,
          schema,
          hasEditor,
          editorUrl,
          fieldsBaseUrl,
          save: buildSaveFn(sel.path),
        }
      }
      case 'fragmentEdit': {
        const frag = await api.getFragment(sel.fragmentName, {
          signal,
          locale: useLocaleStore().effectiveLocale ?? undefined,
        })
        const fragContent = (frag.content as Record<string, unknown>) ?? {}
        const { schema, hasEditor, editorUrl, fieldsBaseUrl } = await fetchSchema(frag.template, signal)
        return {
          template: frag.template,
          path: `@${sel.fragmentName}`,
          content: fragContent,
          schema,
          hasEditor,
          editorUrl,
          fieldsBaseUrl,
          save: c =>
            api
              .updateFragment(
                sel.fragmentName,
                { content: c },
                { locale: useLocaleStore().effectiveLocale ?? undefined },
              )
              .then(() => {}),
        }
      }
      case 'fragmentLink':
        throw new Error('fragmentLink does not produce an EditingTarget')
    }
  }

  // --- The single navigation entry point ---

  /**
   * Navigate to a component selection. Cancels any pending navigation,
   * stashes dirty edits, and opens the target.
   *
   * This is the only function that starts async editor loads. All
   * component tree clicks, hash restorations, and post-restore re-opens
   * go through here.
   */
  async function navigate(sel: EditorSelection) {
    cancelPending()
    stashCurrent()

    // Fragment links are synchronous — no fetch, no abort needed
    if (sel.kind === 'fragmentLink') {
      ec.showFragmentLink(sel.treePath)
      return
    }

    // Check stash before fetching
    const stashKey = selectionToStashKey(sel)
    if (stashKey) {
      const stashed = stash.restore(stashKey)
      if (stashed) {
        persistence.saving = false
        persistence.lastSaveError = null
        await ec.open(stashed.target, stashed.editedContent)
        usePreviewStore().invalidateDraft()
        return
      }
    }

    // Async fetch — cancellable via AbortController
    navController = new AbortController()
    const { signal } = navController
    try {
      const target = await buildTarget(sel, signal)
      persistence.saving = false
      persistence.lastSaveError = null
      await ec.open(target)
      usePreviewStore().invalidateDraft()
      retryAttempt = 0
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      ec.setLoadError(`Failed to load "${selectionToErrorLabel(sel)}": ${(err as Error).message}`)
      retryAttempt++
      if (retryAttempt < MAX_RETRY_ATTEMPTS) {
        const delay = BASE_RETRY_DELAY * 2 ** (retryAttempt - 1)
        retryTimer = setTimeout(() => {
          retryTimer = null
          navigate(sel)
        }, delay)
      }
    }
  }

  // --- Convenience wrappers (for backward compatibility) ---

  async function openComponent(namePath: string, templateName: string) {
    await navigate({ kind: 'component', path: namePath, template: templateName })
  }

  async function openPageRoot() {
    await navigate({ kind: 'root' })
  }

  async function openFragment(fragName: string) {
    await navigate({ kind: 'fragmentEdit', fragmentName: fragName })
  }

  function showFragmentLink(nameOrPath: string) {
    const fragmentName = nameOrPath.startsWith('@') ? nameOrPath.split('/')[0].slice(1) : nameOrPath
    const childPath = nameOrPath.includes('/') ? nameOrPath.split('/').slice(1).join('/') : null
    const treePath = nameOrPath.startsWith('@') ? nameOrPath : `@${nameOrPath}`
    navigate({ kind: 'fragmentLink', fragmentName, treePath, childPath })
  }

  // --- Content operations (with preview side effects) ---

  function markDirty(newContent: Record<string, unknown>) {
    ec.markDirty(newContent)
    usePreviewStore().invalidateDraft()
  }

  function revertStashed(componentPath: string) {
    stash.revert(componentPath)
    usePreviewStore().invalidateDraft()
  }

  // --- Structural operations (with preview side effects) ---

  function moveComponentStructural(
    key: ManifestKey,
    current: readonly import('gazetta/types').ComponentEntry[],
    fromIndex: number,
    toIndex: number,
  ) {
    structural.moveComponent(key, current, fromIndex, toIndex)
    usePreviewStore().invalidateDraft()
  }

  function addComponentStructural(
    key: ManifestKey,
    current: readonly import('gazetta/types').ComponentEntry[],
    component: import('gazetta/types').InlineComponent | string,
    insertIndex?: number,
  ) {
    structural.addComponent(key, current, component, insertIndex)
    usePreviewStore().invalidateDraft()
  }

  function removeComponentStructural(
    key: ManifestKey,
    current: readonly import('gazetta/types').ComponentEntry[],
    atIndex: number,
  ) {
    structural.removeComponent(key, current, atIndex)
    usePreviewStore().invalidateDraft()
  }

  /**
   * Derive the manifest key for the currently-selected page or fragment.
   * Returns null when nothing is selected.
   */
  function currentManifestKey(): ManifestKey | null {
    const sel = useSelectionStore().selection
    if (!sel) return null
    return { kind: sel.type, name: sel.name }
  }

  function discard() {
    ec.discard()
    const key = currentManifestKey()
    if (key) structural.discard(key)
    usePreviewStore().invalidateDraft()
  }

  // --- Clear ---

  function clear() {
    cancelPending()
    ec.clear()
    persistence.saving = false
    persistence.lastSaveError = null
    stash.clearAll()
    structural.clearAll()
  }

  // --- Save ---

  function buildUndoAction(): { label: string; handler: () => Promise<void> } | undefined {
    const active = useActiveTargetStore().activeTargetName
    if (!active) return undefined
    return {
      label: 'Undo',
      handler: async () => {
        try {
          await api.undoLastWrite(active)
          await refreshAfterRestore()
          toast.show('Undone')
        } catch (err) {
          toast.showError(err, 'Undo failed')
        }
      },
    }
  }

  /**
   * Build a StructuralWrite closure for one pending entry. The closure POSTs
   * the new components array via api.updatePage / api.updateFragment when
   * called by the persistence orchestrator.
   */
  function buildStructuralWrite(keyString: string, components: unknown[]): StructuralWrite {
    const key = manifestKeyFromString(keyString)
    const localeOpts = { locale: useLocaleStore().effectiveLocale ?? undefined }
    return {
      label: keyString,
      write: async () => {
        if (key.kind === 'page') {
          await api.updatePage(key.name, { components: components as never }, localeOpts)
        } else {
          await api.updateFragment(key.name, { components: components as never }, localeOpts)
        }
      },
    }
  }

  async function save() {
    const current = ec.target && ec.content ? { target: ec.target, content: ec.content } : null
    const stashedEntries = [...stash.values()]
    const stashedKeys = [...stash.entries].map(([k]) => k)
    const structuralEntries = structural.allEntries()
    const structuralWrites = structuralEntries.map(([k, entry]) => buildStructuralWrite(k, entry.pending))
    const result = await persistence.save(current, stashedEntries, structuralWrites)
    if (result.success) {
      ec.markSaved()
      for (const key of stashedKeys) stash.revert(key)
      structural.clearAll()
      // Reload the affected manifests so selection.detail reflects the saved
      // structural changes — preview will repaint from disk on the next fetch.
      if (structuralEntries.length > 0) {
        await useSelectionStore().reload()
      }
      usePreviewStore().invalidate()
      usePublishStatusStore().refresh()
      toast.show('Saved', { action: buildUndoAction() })
    } else {
      toast.showError(new Error(result.error), 'Failed to save')
    }
  }

  // --- Post-restore refresh ---

  async function refreshAfterRestore(): Promise<void> {
    const targetSnapshot = ec.target ? { template: ec.target.template, path: ec.target.path } : null
    clear()
    await useSiteStore().reload()
    await useSelectionStore().reload()
    if (targetSnapshot) {
      const sel: EditorSelection =
        targetSnapshot.path === '_root'
          ? { kind: 'root' }
          : { kind: 'component', path: targetSnapshot.path, template: targetSnapshot.template }
      await navigate(sel)
    }
    usePreviewStore().invalidate()
    usePublishStatusStore().refresh()
  }

  // --- Derived state ---

  const pendingCount = computed(() => stash.size + (ec.dirty ? 1 : 0) + structural.pendingCount)
  const hasPendingEdits = computed(() => pendingCount.value > 0)
  /**
   * Aggregated draft overrides for the preview server. Both lanes always
   * present; consumers send the whole shape over the wire (server contract is
   * `{ content, structural }` with both fields required).
   */
  const allOverrides = computed<DraftOverrides>(() => {
    const content: DraftOverrides['content'] = {}
    for (const entry of stash.entries) content[entry[0]] = entry[1].editedContent
    if (ec.path && ec.content && ec.dirty) content[ec.path] = ec.content

    const structuralOverrides: DraftOverrides['structural'] = {}
    for (const [k, entry] of structural.allEntries()) {
      structuralOverrides[k] = entry.pending
    }
    return { content, structural: structuralOverrides }
  })

  // --- Beforeunload guard ---

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
      if (hasPendingEdits.value) {
        e.preventDefault()
        e.returnValue = ''
      }
    })
  }

  return {
    // Primary entry point
    navigate,
    // Convenience wrappers (backward compat — callers can migrate to navigate() over time)
    openComponent,
    openPageRoot,
    openFragment,
    showFragmentLink,
    // Other actions
    markDirty,
    revertStashed,
    moveComponentStructural,
    addComponentStructural,
    removeComponentStructural,
    discard,
    clear,
    save,
    refreshAfterRestore,
    // Derived state
    pendingCount,
    hasPendingEdits,
    hasPendingEdit: (path: string) => stash.has(path),
    allOverrides,
  }
}
