<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { onKeyStroke } from '@vueuse/core'
import { useEditingStore } from '../stores/editing.js'
import { useSelectionStore } from '../stores/selection.js'
import { useThemeStore } from '../stores/theme.js'
import { useUnsavedGuardStore } from '../stores/unsavedGuard.js'
import { hashToSelection, fragmentLinkDestinationHash } from '../composables/editorSelection.js'
import { useEditorMount } from '../composables/useEditorMount.js'
import { createEditorMount } from 'gazetta/editor'
import type { EditorMount } from 'gazetta/types'
import FragmentBlastRadius from './FragmentBlastRadius.vue'
import PageMetadataEditor from './PageMetadataEditor.vue'
import ValidationBanner from './ValidationBanner.vue'
import ConflictBanner from './ConflictBanner.vue'
import { useLocaleStore } from '../stores/locale.js'
import { manifestPath } from '../stores/editorEtags.js'
import { useConflictDiscard } from '../composables/useConflictDiscard.js'

const editing = useEditingStore()
const selection = useSelectionStore()
const theme = useThemeStore()
const unsavedGuard = useUnsavedGuardStore()
const localeStore = useLocaleStore()
const conflictDiscard = useConflictDiscard()
const route = useRoute()
const router = useRouter()
const containerRef = ref<HTMLElement | null>(null)

async function goToFragment() {
  const fragName = editing.fragmentLink
  if (!fragName) return
  // Derive child path from route hash — the hash already encodes the selection
  // (e.g. #@header/logo → childPath = logo)
  const sel = hashToSelection(route.hash, false)
  const hash = sel?.kind === 'fragmentLink' && sel.childPath ? fragmentLinkDestinationHash(sel) : ''
  if (editing.hasPendingEdits) {
    const result = await unsavedGuard.guard()
    if (result === 'cancel') return
    if (result === 'save') await editing.save()
  }
  editing.clear()
  await router.push({ path: `/fragments/${fragName}/edit`, hash })
}

// Show blast radius when the selected root item is a fragment, regardless
// of which sub-component is currently in the editor. The badge is about
// the fragment's reach, not the current sub-edit.
const fragmentName = computed(() => (selection.type === 'fragment' ? selection.name : null))

const hasProperties = computed(() => {
  const s = editing.schema as Record<string, unknown> | null
  if (!s) return false
  const props = s.properties as Record<string, unknown> | undefined
  return props && Object.keys(props).length > 0
})

const editorMountRef = computed<EditorMount | null>(() => {
  if (!editing.schema || !hasProperties.value) return null
  // Use custom editor if loaded, otherwise default @rjsf form
  if (editing.customEditorMount) return editing.customEditorMount
  return createEditorMount(editing.schema)
})

const contentRef = computed(() => editing.content)
const schemaRef = computed(() => editing.schema as Record<string, unknown> | null)
const themeRef = computed<'dark' | 'light'>(() => (theme.dark ? 'dark' : 'light'))
const mountVersionRef = computed(() => editing.mountVersion)
const fieldsBaseUrlRef = computed(() => editing.target?.fieldsBaseUrl)

function handleChange(content: Record<string, unknown>) {
  editing.markDirty(content)
}

useEditorMount(
  containerRef,
  editorMountRef,
  contentRef,
  schemaRef,
  themeRef,
  handleChange,
  mountVersionRef,
  fieldsBaseUrlRef,
)

// Ctrl+S / Cmd+S to save
onKeyStroke('s', e => {
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault()
    if (editing.dirty) editing.save()
  }
})

// Active manifest path — used by the ConflictBanner. The banner only
// renders when a conflict exists for THIS path, so a conflict on
// `pages/home/page.json` doesn't show while the author is editing
// `pages/about/page.json`. Conflicts persist across navigation per
// design-offline.md Q4.
const activeManifestPath = computed<string | null>(() => {
  if (!selection.selection) return null
  const kind = selection.type === 'page' ? 'page' : 'fragment'
  const locale = localeStore.effectiveLocale ?? undefined
  return manifestPath(kind, selection.selection.name, locale)
})

const showConflictBanner = computed(() => activeManifestPath.value !== null)

/**
 * Author chose "Discard my changes" — delegate to the dedicated
 * conflict-discard composable. The orchestration (clear conflict
 * → drop local pending → reload selection) lives there so the
 * flow is independently testable without mounting the editor's
 * real-DOM machinery.
 */
async function handleConflictDiscard() {
  if (!activeManifestPath.value) return
  await conflictDiscard.run(activeManifestPath.value)
}
</script>

<template>
  <div class="editor-panel" data-testid="editor-panel">
    <ValidationBanner />
    <ConflictBanner
      v-if="showConflictBanner && activeManifestPath"
      :itemPath="activeManifestPath"
      @discard="handleConflictDiscard" />
    <div v-if="editing.loadError" class="editor-error" data-testid="editor-error">
      <i class="pi pi-exclamation-triangle" />
      <p>{{ editing.loadError }}</p>
    </div>
    <div v-else-if="editing.fragmentLink" class="editor-fragment-link" data-testid="editor-fragment-link">
      <i class="pi pi-share-alt" />
      <p>This is part of a shared fragment.</p>
      <a class="fragment-go-link" data-testid="fragment-go-link" @click.stop.prevent="goToFragment">Edit @{{ editing.fragmentLink }}</a>
    </div>
    <div v-else-if="!editing.path" class="editor-empty" data-testid="editor-empty">
      <i class="pi pi-pencil" style="font-size: 2rem; opacity: 0.3; margin-bottom: 0.5rem;" />
      <p>Select a component to edit</p>
    </div>
    <div v-else class="editor-active">
      <div class="editor-header">
        <h3>{{ editing.template }}</h3>
        <FragmentBlastRadius v-if="fragmentName" :fragmentName="fragmentName" />
      </div>
      <div v-if="hasProperties" ref="containerRef" class="editor-container" data-testid="editor-container" :key="editing.path" />
      <PageMetadataEditor v-if="selection.type === 'page' && editing.path === '_root'" />
      <p v-else-if="!hasProperties" class="editor-no-schema">No editable content. Edit its children instead.</p>
    </div>
  </div>
</template>

<style scoped>
.editor-panel h3 { font-size: 0.75rem; text-transform: uppercase; color: var(--color-muted); letter-spacing: 0.05em; margin: 0; }
.editor-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.editor-error { color: var(--color-danger-fg); font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; gap: 0.5rem; text-align: center; }
.editor-error .pi { font-size: 2rem; }
.editor-error p { max-width: 300px; line-height: 1.5; }
.editor-empty { color: var(--color-muted); font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; }
.editor-fragment-link { color: var(--color-muted); font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; gap: 0.5rem; }
.editor-fragment-link .pi { font-size: 2rem; opacity: 0.3; }
.fragment-go-link { color: var(--color-primary); cursor: pointer; font-weight: 500; }
.fragment-go-link:hover { text-decoration: underline; }
.editor-container { font-size: 0.875rem; }
.editor-no-schema { color: var(--color-muted); font-size: 0.875rem; }
</style>
