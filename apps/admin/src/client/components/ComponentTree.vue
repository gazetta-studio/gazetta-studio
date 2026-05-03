<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import { useSelectionStore } from '../stores/selection.js'
import { useEditingStore } from '../stores/editing.js'
import { useToastStore } from '../stores/toast.js'
import { useComponentFocusStore } from '../stores/componentFocus.js'
import { useFragmentsApi } from '../composables/api.js'
import { hashToSelection, selectionToHash, type EditorSelection } from '../composables/editorSelection.js'
import { useUiModeStore } from '../stores/uiMode.js'
import { useEditorStructuralStore } from '../stores/editorStructural.js'
import AddComponentDialog from './AddComponentDialog.vue'

const fragmentsApi = useFragmentsApi()
const route = useRoute()
const router = useRouter()
const uiMode = useUiModeStore()

/** FNV-1a hash — same function as in packages/gazetta/src/scope.ts */
function hashPath(path: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

interface NodeData {
  treePath?: string
  path?: string
  template?: string
  isFragment?: boolean
  isPage?: boolean
  fragName?: string
  index?: number
  isTopLevel?: boolean
  error?: string
}

interface ComponentNode {
  key: string
  label: string
  data: NodeData
  children: ComponentNode[]
}

const selection = useSelectionStore()
const editing = useEditingStore()
const toast = useToastStore()
const focus = useComponentFocusStore()
const structural = useEditorStructuralStore()
const selectedNodeKey = ref<string | null>(null)
const hoveredNodeKey = ref<string | null>(null)
const componentNodes = ref<ComponentNode[]>([])
const showAddDialog = ref(false)

const detail = computed(() => selection.detail)
/**
 * Effective components — pending structural override when present, otherwise
 * the disk-loaded array. The tree binds to this so move/add/remove are
 * reflected immediately without waiting for save.
 */
const effectiveComponents = computed(() => {
  const sel = selection.selection
  const d = detail.value
  if (!sel || !d) return null
  const pending = structural.pendingFor({ kind: sel.type, name: sel.name })
  return pending ?? d.components ?? []
})
const componentCount = computed(() => effectiveComponents.value?.length ?? 0)

// Map from data-gz hash → component info (built during tree construction)
type GzEntry = { path: string; template: string } | { isFragment: true; fragName: string }
const gzMap = ref(new Map<string, GzEntry>())

async function buildComponentNode(
  entry: import('../api/client.js').ComponentEntry,
  index: number,
  parentTreePath: string,
  map: Map<string, GzEntry>,
): Promise<ComponentNode> {
  // Fragment reference
  if (typeof entry === 'string') {
    const fragName = entry.slice(1)
    const treePath = parentTreePath ? `${parentTreePath}/${entry}` : entry
    const gzId = hashPath(treePath)
    map.set(gzId, { isFragment: true, fragName })
    try {
      const frag = await fragmentsApi.getFragment(fragName)
      const children = frag.components
        ? await Promise.all(frag.components.map((c, i) => buildComponentNode(c, i, treePath, map)))
        : []
      return {
        key: `frag:${fragName}:${index}`,
        label: entry,
        data: {
          isFragment: true,
          fragName,
          treePath,
          path: treePath,
          template: frag.template,
          index,
          isTopLevel: true,
        },
        children,
      }
    } catch (err) {
      return {
        key: `frag:${fragName}:${index}`,
        label: entry,
        data: { isFragment: true, fragName, treePath, index, isTopLevel: true, error: (err as Error).message },
        children: [],
      }
    }
  }

  // Inline component
  const treePath = parentTreePath ? `${parentTreePath}/${entry.name}` : entry.name
  const gzId = hashPath(treePath)
  const children: ComponentNode[] = entry.components
    ? await Promise.all(entry.components.map((c, i) => buildComponentNode(c, i, treePath, map)))
    : []

  map.set(gzId, { path: treePath, template: entry.template })

  return {
    key: `comp:${treePath}:${index}`,
    label: entry.name,
    data: { path: treePath, template: entry.template, treePath, isFragment: false, index, isTopLevel: true },
    children: children.map(c => ({ ...c, data: { ...c.data, isTopLevel: false } })),
  }
}

watch(
  [detail, effectiveComponents],
  async ([d, comps]) => {
    if (!d) {
      componentNodes.value = []
      gzMap.value = new Map()
      return
    }

    const map = new Map<string, GzEntry>()
    const rootPath = selection.type === 'fragment' ? `@${selection.name}` : ''
    const children = comps
      ? await Promise.all(comps.map((entry, i) => buildComponentNode(entry, i, rootPath, map)))
      : []

    const rootNode: ComponentNode = {
      key: `root:${selection.name}`,
      label: selection.name ?? '',
      data: { isPage: true, path: d.dir, template: d.template, treePath: rootPath },
      children,
    }
    // Fragment root has data-gz in host-page preview — add to gzMap for click-to-select
    if (rootPath && selection.type === 'fragment' && selection.name) {
      map.set(hashPath(rootPath), { isFragment: true, fragName: selection.name })
    }
    componentNodes.value = [rootNode]
    gzMap.value = map
    selectedNodeKey.value = null

    // Process pending selection if tree just built and a gzId is waiting
    consumePending()
    // Hash-based restore is handled by the route.hash watcher below.
    // Trigger it now in case the hash was already set before the tree built.
    if (!focus.pendingGzId) applyHashSelection()
  },
  { immediate: true },
)

function consumePending() {
  if (focus.pendingGzId && gzMap.value.size > 0) {
    selectByGzId(focus.pendingGzId)
    focus.clearPending()
  }
}

/**
 * Read the current route hash and open the corresponding editor.
 * This is the SINGLE place that translates a URL hash into editor state.
 * Called from:
 * - the detail watcher (after tree builds — handles page refresh)
 * - the route.hash watcher (handles click-driven hash changes)
 */
function applyHashSelection() {
  if (componentNodes.value.length === 0) return
  const onFragmentPage = selection.type === 'fragment'
  const sel = hashToSelection(route.hash, onFragmentPage)
  if (!sel) return

  // Find and highlight the tree node
  const prefix = onFragmentPage && selection.name ? `@${selection.name}/` : ''
  switch (sel.kind) {
    case 'root': {
      const rootNode = componentNodes.value[0]
      if (rootNode) selectedNodeKey.value = rootNode.key
      break
    }
    case 'component': {
      const fullPath = prefix + sel.path
      const found = findNodeByKey(componentNodes.value, d => d.path === fullPath || d.path === sel.path)
      if (found) {
        selectedNodeKey.value = found.key
        sel.template = found.data?.template ?? ''
      }
      break
    }
    case 'fragmentLink': {
      const found = sel.childPath
        ? findNodeByKey(componentNodes.value, d => d.path === sel.treePath)
        : findNodeByKey(componentNodes.value, d => d.fragName === sel.fragmentName)
      if (found) selectedNodeKey.value = found.key
      break
    }
    case 'fragmentEdit': {
      const found = findNodeByKey(componentNodes.value, d => d.fragName === sel.fragmentName)
      if (found) selectedNodeKey.value = found.key
      break
    }
  }

  // Open the editor — NO hash write here (URL is already correct)
  switch (sel.kind) {
    case 'root':
      editing.openPageRoot()
      break
    case 'component':
      editing.openComponent(sel.path, sel.template)
      break
    case 'fragmentLink':
      editing.showFragmentLink(sel.treePath)
      break
    case 'fragmentEdit':
      editing.openFragment(sel.fragmentName)
      break
  }
}

// React to hash changes — this is the single driver of editor state from URL.
// Fires on: click (onSelect writes hash), goToFragment (router.push with hash),
// page refresh (hash already in URL), browser back/forward.
watch(
  () => route.hash,
  () => applyHashSelection(),
)

// Also react to pendingGzId changes when tree is already built (edit mode click-to-select)
watch(
  () => focus.pendingGzId,
  () => consumePending(),
)

// Highlight tree node when component is hovered in preview
watch(
  () => focus.previewHoverGzId,
  gzId => {
    if (!gzId) {
      hoveredNodeKey.value = null
      return
    }
    const found = findNodeByKey(componentNodes.value, d => (d.treePath ? hashPath(d.treePath) === gzId : false))
    hoveredNodeKey.value = found?.key ?? null
  },
)

// Flat list for rendering — walk tree and produce { node, depth } pairs
const flatNodes = computed(() => {
  const result: { node: ComponentNode; depth: number }[] = []
  function walk(nodes: ComponentNode[], depth: number) {
    for (const node of nodes) {
      result.push({ node, depth })
      if (node.children.length) walk(node.children, depth + 1)
    }
  }
  if (componentNodes.value[0]) {
    result.push({ node: componentNodes.value[0], depth: -1 })
    walk(componentNodes.value[0].children, 0)
  }
  return result
})

function nodeIcon(node: ComponentNode, depth: number): string {
  if (depth === -1) return selection.type === 'page' ? 'pi pi-file' : 'pi pi-share-alt'
  if (node.data.isFragment) return 'pi pi-share-alt'
  return 'pi pi-box'
}

function nodeStyle(depth: number): Record<string, string> | undefined {
  if (depth <= 0) return undefined
  return { paddingLeft: depth * 10 + 'px' }
}

// --- Editing helpers — delegated to editing store ---

function revertComponent(componentPath: string) {
  if (editing.path === componentPath) {
    editing.discard()
  } else {
    editing.revertStashed(componentPath)
  }
}

// --- Hover highlight ---

function onHover(node: ComponentNode) {
  if (!node.data.treePath) return
  focus.highlight(hashPath(node.data.treePath!))
}

function onHoverEnd() {
  focus.highlight(null)
}

// --- Node selection ---

/** Strip the @fragName/ prefix from a component path on fragment pages. */
function stripFragmentPrefix(path: string): string {
  const prefix = selection.type === 'fragment' && selection.name ? `@${selection.name}/` : ''
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** Derive a typed selection from a clicked tree node. */
function nodeToSelection(node: ComponentNode): EditorSelection | null {
  if (!node.data) return null
  if (node.data.isPage) return { kind: 'root' }
  if (node.data.isFragment && node.data.fragName) {
    if (selection.type === 'page') {
      return {
        kind: 'fragmentLink',
        fragmentName: node.data.fragName,
        treePath: `@${node.data.fragName}`,
        childPath: null,
      }
    }
    return { kind: 'fragmentEdit', fragmentName: node.data.fragName }
  }
  if (!node.data.path) return null
  if (selection.type === 'page' && node.data.path.startsWith('@')) {
    const parts = node.data.path.slice(1).split('/')
    return {
      kind: 'fragmentLink',
      fragmentName: parts[0],
      treePath: node.data.path,
      childPath: parts.length > 1 ? parts.slice(1).join('/') : null,
    }
  }
  return { kind: 'component', path: stripFragmentPrefix(node.data.path), template: node.data.template ?? '' }
}

async function onSelect(node: ComponentNode) {
  if (!node.data) return
  selectedNodeKey.value = node.key
  focus.clearPending()
  const treePath = node.data.treePath
  focus.select(treePath ? hashPath(treePath) : null)
  const sel = nodeToSelection(node)
  if (!sel) return
  if (uiMode.mode === 'edit') {
    // Write the hash — the route.hash watcher will open the editor.
    const hash = selectionToHash(sel)
    if (route.hash !== hash) {
      router.push({ hash, replace: true })
    } else {
      // Hash unchanged (e.g. clicking same component) — apply directly
      applyHashSelection()
    }
  } else {
    // Browse mode — clicking a component enters edit mode.
    // Write the hash and navigate to the edit URL.
    const hash = selectionToHash(sel)
    const prefix = selection.type === 'page' ? '/pages' : '/fragments'
    router.push({ path: `${prefix}/${selection.name}/edit`, hash })
  }
}

// Find a node by walking the tree
function findNodeByKey(nodes: ComponentNode[], predicate: (data: NodeData) => boolean): ComponentNode | null {
  for (const node of nodes) {
    if (node.data && predicate(node.data)) return node
    if (node.children.length) {
      const found = findNodeByKey(node.children, predicate)
      if (found) return found
    }
  }
  return null
}

// Select a component by its data-gz hash (called from PreviewPanel)
function selectByGzId(gzId: string) {
  const entry = gzMap.value.get(gzId)
  if (!entry) return
  focus.select(gzId)
  let sel: EditorSelection
  if ('isFragment' in entry) {
    const found = findNodeByKey(componentNodes.value, d => d.fragName === entry.fragName)
    if (found) selectedNodeKey.value = found.key
    sel =
      selection.type === 'page'
        ? { kind: 'fragmentLink', fragmentName: entry.fragName, treePath: `@${entry.fragName}`, childPath: null }
        : { kind: 'fragmentEdit', fragmentName: entry.fragName }
  } else {
    const found = findNodeByKey(componentNodes.value, d => d.path === entry.path)
    if (found) selectedNodeKey.value = found.key
    if (selection.type === 'page' && entry.path.startsWith('@')) {
      const parts = entry.path.slice(1).split('/')
      sel = {
        kind: 'fragmentLink',
        fragmentName: parts[0],
        treePath: entry.path,
        childPath: parts.length > 1 ? parts.slice(1).join('/') : null,
      }
    } else {
      sel = { kind: 'component', path: stripFragmentPrefix(entry.path), template: entry.template }
    }
  }
  // Write hash — the watcher opens the editor
  const hash = selectionToHash(sel)
  if (route.hash !== hash) {
    router.push({ hash, replace: true })
  } else {
    applyHashSelection()
  }
}

// --- Component operations ---

/**
 * Manifest key for the currently-selected page or fragment.
 * Returns null when nothing is selected — callers no-op in that case.
 */
function currentManifestKey(): import('gazetta/types').ManifestKey | null {
  const sel = selection.selection
  if (!sel) return null
  return { kind: sel.type, name: sel.name }
}

function moveComponent(index: number, direction: -1 | 1) {
  const comps = effectiveComponents.value
  if (!comps) return
  const newIndex = index + direction
  if (newIndex < 0 || newIndex >= comps.length) return
  const key = currentManifestKey()
  if (!key) return
  editing.moveComponentStructural(key, comps, index, newIndex)
}

function removeComponent(index: number) {
  const comps = effectiveComponents.value
  if (!comps) return
  const key = currentManifestKey()
  if (!key) return

  const removed = comps[index]
  const removedName = typeof removed === 'string' ? removed : removed.name

  // The path is about to disappear from the manifest — drop any open editor
  // or stash entry under it so save never persists orphan content. Other
  // pending state (sibling components' edits, the page's structural lane) is
  // preserved — only the removed component's slot is cleared.
  editing.clearEditorForRemovedPath(removedName)
  editing.removeComponentStructural(key, comps, index)
  toast.show(`Removed "${removedName}"`)
}

function addComponent(name: string, template: string) {
  const comps = effectiveComponents.value
  if (!comps) return
  const key = currentManifestKey()
  if (!key) return
  const entry: import('../api/client.js').InlineComponent = { name, template, content: {} }
  editing.addComponentStructural(key, comps, entry)
  toast.show(`Added "${name}"`)
}
</script>

<template>
  <div v-if="detail" class="component-tree">
    <template v-if="flatNodes.length">
      <div v-for="{ node, depth } in flatNodes" :key="node.key"
        :class="['node-item', { 'node-root': depth === -1, selected: selectedNodeKey === node.key, hovered: hoveredNodeKey === node.key }]"
        :style="nodeStyle(depth)"
        :data-testid="`component-${node.data?.isFragment ? node.data.fragName : node.label}`"
        @click="onSelect(node)"
        @mouseenter="onHover(node)"
        @mouseleave="onHoverEnd()">
        <i v-if="node.data?.error" class="pi pi-exclamation-triangle node-icon node-error-icon"
          :title="node.data.error" />
        <i v-else :class="nodeIcon(node, depth)" class="node-icon" />
        <span v-if="node.data?.path && (editing.hasPendingEdit(node.data.path) || (editing.dirty && editing.path === node.data.path))" class="node-dirty-dot" />
        <span class="node-label">{{ node.label }}</span>
        <Button v-if="node.data?.path && (editing.hasPendingEdit(node.data.path) || (editing.dirty && editing.path === node.data.path))"
          icon="pi pi-undo" text rounded size="small" class="node-revert"
          title="Discard changes" @click.stop="revertComponent(node.data.path!)" />
        <span v-if="node.data?.isTopLevel && depth !== -1" class="node-actions">
          <Button icon="pi pi-arrow-up" text rounded size="small"
            :data-testid="`move-up-${node.label}`"
            :aria-label="`Move ${node.label} up`"
            :disabled="(node.data.index as number) === 0"
            @click.stop="moveComponent(node.data.index as number, -1)" />
          <Button icon="pi pi-arrow-down" text rounded size="small"
            :data-testid="`move-down-${node.label}`"
            :aria-label="`Move ${node.label} down`"
            :disabled="(node.data.index as number) === componentCount - 1"
            @click.stop="moveComponent(node.data.index as number, 1)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger"
            :data-testid="`remove-${node.label}`"
            :aria-label="`Remove ${node.label}`"
            @click.stop="removeComponent(node.data.index as number)" />
        </span>
      </div>
    </template>
    <p v-else class="empty">No components</p>

    <Button icon="pi pi-plus" label="Add component" text size="small" class="add-btn"
      data-testid="add-component" @click="showAddDialog = true" />

    <AddComponentDialog v-if="showAddDialog" :visible="showAddDialog"
      @close="showAddDialog = false" @add="addComponent" />
  </div>
</template>

<style scoped>
.component-tree { font-size: 13px; line-height: 22px; }
.empty { color: var(--color-muted); }
.node-item { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; margin: 0 2px; cursor: pointer; border-radius: 3px; }
.node-item:hover, .node-item.hovered { background: var(--color-hover-bg); }
.node-item.selected { background: rgba(167, 139, 250, 0.15); box-shadow: inset 2px 0 0 var(--p-violet-400); }
.node-root { font-weight: 600; padding: 0 6px; height: 26px; line-height: 26px; border-radius: 0; margin: 0 0 2px 0; border-bottom: 1px solid var(--color-border); }
.node-root.selected { background: rgba(167, 139, 250, 0.1); box-shadow: none; border-bottom-color: var(--p-violet-400); }
.node-icon { width: 16px; text-align: center; font-size: 10px; color: var(--color-muted); flex-shrink: 0; }
.node-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-muted); }
.node-item.selected .node-label,
.node-item:hover .node-label,
.node-item.hovered .node-label,
.node-root .node-label { color: var(--color-fg); }
.node-error-icon { color: var(--color-danger-fg); }
.node-dirty-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning-fg); flex-shrink: 0; }
.node-revert { opacity: 0; transition: opacity 0.1s; width: 18px; height: 18px; flex-shrink: 0; }
.node-item:hover .node-revert { opacity: 1; }
.node-actions { display: flex; gap: 0; opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
.node-item:hover .node-actions { opacity: 1; }
.add-btn { margin-top: 6px; }
</style>
