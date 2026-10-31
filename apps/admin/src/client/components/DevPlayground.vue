<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ChevronDown, ChevronRight, Code, File as FileIcon, Pencil, RefreshCw, SlidersHorizontal } from '@lucide/vue'
import { useRouter, useRoute } from 'vue-router'
import { onKeyStroke } from '@vueuse/core'
import { useThemeStore } from '../stores/theme.js'
import { usePagesApi, useFragmentsApi, useTemplatesApi } from '../composables/api.js'
import type { EditorMount, FieldMount } from 'gazetta/types'
import { createEditorMount } from 'gazetta/editor'
import TemplateImpactPanel from './TemplateImpactPanel.vue'

const theme = useThemeStore()
const router = useRouter()
const route = useRoute()
const pagesApi = usePagesApi()
const fragmentsApi = useFragmentsApi()
const templatesApi = useTemplatesApi()

// ESC exits playground — matches edit mode + fullscreen pattern
onKeyStroke('Escape', () => {
  const active = document.activeElement as HTMLElement | null
  if (
    active &&
    (active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.tagName === 'SELECT' ||
      active.isContentEditable)
  ) {
    active.blur()
    return
  }
  router.back()
})

// --- Data ---
interface TemplateItem {
  name: string
  hasEditor: boolean
}
interface FieldItem {
  name: string
  path: string
}
type SelectedEditor = {
  type: 'editor'
  name: string
  hasEditor: boolean
  editorUrl?: string
  fieldsBaseUrl?: string
  schema: Record<string, unknown>
  realContent?: Record<string, unknown>
}
type SelectedField = { type: 'field'; name: string; fieldsBaseUrl: string }
type Selected = SelectedEditor | SelectedField

const templates = ref<TemplateItem[]>([])
const fields = ref<FieldItem[]>([])
const loading = ref(true)
const selected = ref<Selected | null>(null)
const schemaLoading = ref(false)
const mountError = ref<string | null>(null)
const showAllTemplates = ref(false)

// Cut 6 — Impact tab. Two tabs only when an editor (template) is
// selected: Preview (existing form + value inspector) and Impact
// (items using this template + their issues). Field selections skip
// tabs entirely (no impact concept for fields). Tab state persists
// via the `?tab=impact` query param so the toolbar banner's deep-link
// can land directly on the Impact view.
type DevTab = 'preview' | 'impact'
const activeTab = ref<DevTab>((route.query.tab as DevTab | undefined) === 'impact' ? 'impact' : 'preview')

function selectTab(t: DevTab) {
  if (activeTab.value === t) return
  activeTab.value = t
  // Reflect into the URL so reload + share preserve the tab.
  router.replace({
    path: route.path,
    query: { ...route.query, tab: t === 'preview' ? undefined : 'impact' },
  })
}

// Reset to Preview when switching to a different editor (a fresh
// selection shouldn't preserve a stale tab from a different template).
// Banner deep-links go through router.push BEFORE selectEditor runs,
// so the route's `?tab=impact` is already set; honor it on the next
// editor selection by re-reading the query.
watch(
  () => route.query.tab,
  q => {
    activeTab.value = q === 'impact' ? 'impact' : 'preview'
  },
)

// Value inspector
const currentValue = ref<unknown>(null)
const showInspector = ref(true)

// Mount refs
const mountRef = ref<HTMLElement | null>(null)
let currentMount: { unmount: (el: HTMLElement) => void } | null = null

// --- Load sidebar items (fast — no schema fetching) ---
async function loadSidebar() {
  loading.value = true
  try {
    const [tpl, fld] = await Promise.all([templatesApi.getTemplates(), templatesApi.getFields()])

    // Check which templates have custom editors — one lightweight call each
    const items: TemplateItem[] = []
    for (const t of tpl) {
      try {
        const resp = (await templatesApi.getTemplateSchema(t.name)) as Record<string, unknown> & { hasEditor?: boolean }
        items.push({ name: t.name, hasEditor: !!resp.hasEditor })
      } catch {
        items.push({ name: t.name, hasEditor: false })
      }
    }
    templates.value = items
    fields.value = fld
  } catch (err) {
    console.error('Failed to load playground items:', err)
  } finally {
    loading.value = false
  }
}

loadSidebar().then(() => {
  const editorParam = route.params.editor as string | undefined
  const fieldParam = route.params.field as string | undefined
  if (editorParam && templates.value.some(t => t.name === editorParam)) selectEditor(editorParam)
  else if (fieldParam && fields.value.some(f => f.name === fieldParam)) selectField(fieldParam)
})

// --- Computed ---
const customEditors = computed(() => templates.value.filter(t => t.hasEditor))
const defaultEditors = computed(() => templates.value.filter(t => !t.hasEditor))
const themeMode = computed<'dark' | 'light'>(() => (theme.dark ? 'dark' : 'light'))
const valueHtml = computed(() => {
  try {
    return syntaxHighlight(currentValue.value)
  } catch {
    return escapeHtml(String(currentValue.value))
  }
})

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function syntaxHighlight(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (obj === null) return `<span class="jv-null">null</span>`
  if (typeof obj === 'boolean') return `<span class="jv-bool">${obj}</span>`
  if (typeof obj === 'number') return `<span class="jv-num">${obj}</span>`
  if (typeof obj === 'string') {
    if (obj.includes('\n')) {
      const lines = obj.split('\n').map(l => escapeHtml(l))
      return `<span class="jv-str">"${lines.join(`<br>${pad}  `)}"</span>`
    }
    return `<span class="jv-str">"${escapeHtml(obj)}"</span>`
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    const items = obj.map(v => `${pad}  ${syntaxHighlight(v, indent + 1)}`).join(',\n')
    return `[\n${items}\n${pad}]`
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const props = entries
      .map(([k, v]) => `${pad}  <span class="jv-key">"${escapeHtml(k)}"</span>: ${syntaxHighlight(v, indent + 1)}`)
      .join(',\n')
    return `{\n${props}\n${pad}}`
  }
  return escapeHtml(String(obj))
}

// --- Select an editor (lazy schema load) ---
async function selectEditor(name: string) {
  schemaLoading.value = true
  mountError.value = null
  try {
    const resp = (await templatesApi.getTemplateSchema(name)) as Record<string, unknown> & {
      hasEditor?: boolean
      editorUrl?: string
      fieldsBaseUrl?: string
    }
    const { hasEditor, editorUrl, fieldsBaseUrl, ...schema } = resp

    // Try to find real content from a page that uses this template
    const realContent = await findRealContent(name)

    selected.value = { type: 'editor', name, hasEditor: !!hasEditor, editorUrl, fieldsBaseUrl, schema, realContent }
    // Preserve the tab query — banner deep-link comes in with
    // `?tab=impact`; sidebar clicks come in without and stay on Preview.
    const currentTab = route.query.tab as string | undefined
    router.replace({
      path: `/dev/editor/${name}`,
      query: currentTab === 'impact' ? { tab: 'impact' } : {},
    })
  } catch (err) {
    mountError.value = `Failed to load schema for "${name}": ${(err as Error).message}`
    selected.value = null
  } finally {
    schemaLoading.value = false
  }
}

async function selectField(name: string) {
  // Get fieldsBaseUrl from first template
  let fieldsBaseUrl = ''
  if (templates.value.length) {
    try {
      const resp = (await templatesApi.getTemplateSchema(templates.value[0].name)) as Record<string, unknown> & {
        fieldsBaseUrl?: string
      }
      fieldsBaseUrl = resp.fieldsBaseUrl ?? ''
    } catch {
      /* ignore */
    }
  }
  if (!fieldsBaseUrl) {
    mountError.value = 'No fieldsBaseUrl available'
    return
  }
  selected.value = { type: 'field', name, fieldsBaseUrl }
  router.replace(`/dev/field/${name}`)
}

// --- Find real content from any component that uses this template ---
async function findRealContent(templateName: string): Promise<Record<string, unknown> | undefined> {
  try {
    // Check top-level pages and fragments first
    const [pages, frags] = await Promise.all([pagesApi.getPages(), fragmentsApi.getFragments()])

    for (const p of pages) {
      if (p.template === templateName) {
        const detail = await pagesApi.getPage(p.name)
        if (detail.content && Object.keys(detail.content).length > 0) return detail.content
      }
    }
    for (const f of frags) {
      if (f.template === templateName) {
        const detail = await fragmentsApi.getFragment(f.name)
        if (detail.content && Object.keys(detail.content).length > 0) return detail.content
      }
    }

    // Search inline components within pages and fragments
    function findInlineContent(
      components: import('../api/client.js').ComponentEntry[],
      template: string,
    ): Record<string, unknown> | undefined {
      for (const entry of components) {
        if (typeof entry === 'string') continue
        if (entry.template === template && entry.content) return entry.content as Record<string, unknown>
        if (entry.components) {
          const found = findInlineContent(entry.components, template)
          if (found) return found
        }
      }
      return undefined
    }

    for (const p of pages) {
      const detail = await pagesApi.getPage(p.name)
      if (!detail.components) continue
      const found = findInlineContent(detail.components, templateName)
      if (found) return found
    }
    for (const f of frags) {
      const detail = await fragmentsApi.getFragment(f.name)
      if (!detail.components) continue
      const found = findInlineContent(detail.components, templateName)
      if (found) return found
    }
  } catch {
    /* ignore — fallback to generated mock */
  }
  return undefined
}

// --- Mount/unmount ---
function unmountCurrent() {
  if (currentMount && mountRef.value) {
    try {
      currentMount.unmount(mountRef.value)
    } catch {
      /* ignore */
    }
    currentMount = null
  }
  mountError.value = null
}

async function mountSelected() {
  unmountCurrent()
  if (!selected.value || !mountRef.value) return
  const el = mountRef.value

  try {
    if (selected.value.type === 'editor') {
      const item = selected.value
      const content = item.realContent ?? generateMockContent(item.schema)
      currentValue.value = content

      if (item.hasEditor && item.editorUrl) {
        const mod = await import(/* @vite-ignore */ item.editorUrl)
        const mount = (mod.default ?? mod) as EditorMount
        mount.mount(el, {
          content,
          schema: item.schema,
          theme: themeMode.value,
          onChange: c => {
            currentValue.value = c
          },
          fieldsBaseUrl: item.fieldsBaseUrl,
        })
        currentMount = mount
      } else {
        const mount = createEditorMount(item.schema)
        mount.mount(el, {
          content,
          schema: item.schema,
          theme: themeMode.value,
          onChange: c => {
            currentValue.value = c
          },
          fieldsBaseUrl: item.fieldsBaseUrl,
        })
        currentMount = mount
      }
    } else {
      const item = selected.value
      currentValue.value = ''
      const url = `${item.fieldsBaseUrl}/${item.name}.tsx`
      let mod: unknown
      try {
        mod = await import(/* @vite-ignore */ url)
      } catch {
        mod = await import(/* @vite-ignore */ `${item.fieldsBaseUrl}/${item.name}.ts`)
      }
      const mount = ((mod as Record<string, unknown>).default ?? mod) as FieldMount
      mount.mount(el, {
        value: '',
        schema: {},
        theme: themeMode.value,
        onChange: v => {
          currentValue.value = v
        },
      })
      currentMount = mount
    }
  } catch (err) {
    mountError.value = (err as Error).message
  }
}

function reset() {
  if (selected.value) mountSelected()
}

watch(selected, () => mountSelected(), { flush: 'post' })
onBeforeUnmount(() => unmountCurrent())

// --- Mock data ---
function generateMockContent(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (!props) return {}
  const mock: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(props)) {
    const type = prop.type as string
    if (type === 'string') mock[key] = (prop.default as string) ?? `Sample ${key}`
    else if (type === 'number' || type === 'integer') mock[key] = 42
    else if (type === 'boolean') mock[key] = false
    else if (type === 'array') mock[key] = []
    else if (type === 'object') mock[key] = {}
  }
  return mock
}
</script>

<template>
  <div class="playground" data-testid="dev-playground">
    <!-- Sidebar -->
    <div class="playground-sidebar">
      <div class="sidebar-header">Dev Playground</div>

      <div v-if="loading" class="sidebar-loading">Loading...</div>
      <template v-else-if="templates.length || fields.length">
        <!-- Custom Editors — top priority -->
        <div v-if="customEditors.length" class="sidebar-section">
          <div class="section-label">Custom Editors</div>
          <div v-for="t in customEditors" :key="'ce:' + t.name"
            :class="['sidebar-item', { active: selected?.type === 'editor' && selected.name === t.name }]"
            :data-testid="`playground-editor-${t.name}`"
            @click="selectEditor(t.name)">
            <Pencil class="item-icon" aria-hidden="true" />
            <span class="item-name">{{ t.name }}</span>
          </div>
        </div>

        <!-- Custom Fields -->
        <div v-if="fields.length" class="sidebar-section">
          <div class="section-label">Custom Fields</div>
          <div v-for="f in fields" :key="'f:' + f.name"
            :class="['sidebar-item', { active: selected?.type === 'field' && selected.name === f.name }]"
            :data-testid="`playground-field-${f.name}`"
            @click="selectField(f.name)">
            <SlidersHorizontal class="item-icon" aria-hidden="true" />
            <span class="item-name">{{ f.name }}</span>
          </div>
        </div>

        <!-- All Templates — collapsed by default -->
        <div class="sidebar-section">
          <div class="section-label section-label-toggle" @click="showAllTemplates = !showAllTemplates">
            <component :is="showAllTemplates ? ChevronDown : ChevronRight" class="toggle-icon" aria-hidden="true" />
            All Templates ({{ templates.length }})
          </div>
          <template v-if="showAllTemplates">
            <div v-for="t in defaultEditors" :key="'te:' + t.name"
              :class="['sidebar-item', { active: selected?.type === 'editor' && selected.name === t.name }]"
              :data-testid="`playground-editor-${t.name}`"
              @click="selectEditor(t.name)">
              <FileIcon class="item-icon" aria-hidden="true" />
              <span class="item-name">{{ t.name }}</span>
            </div>
          </template>
        </div>
      </template>

      <div v-else class="sidebar-empty">
        <p>No custom editors or fields yet.</p>
        <p class="hint">Create an editor:<br><code>admin/editors/{name}.tsx</code></p>
        <p class="hint">Create a field:<br><code>admin/fields/{name}.tsx</code></p>
      </div>
    </div>

    <!-- Main area -->
    <div class="playground-main">
      <div v-if="!selected && !schemaLoading" class="main-empty">
        <Code class="empty-icon" style="opacity: 0.3; margin-bottom: 0.5rem;" aria-hidden="true" />
        <p>Select an editor or field to preview</p>
      </div>
      <div v-else-if="schemaLoading" class="main-empty">
        <p>Loading schema...</p>
      </div>
      <template v-else-if="selected">
        <!-- Toolbar -->
        <div class="main-toolbar">
          <span class="toolbar-label">
            <span class="toolbar-type">{{ selected.type === 'editor' ? 'Editor' : 'Field' }}</span>
            <strong>{{ selected.name }}</strong>
            <span v-if="selected.type === 'editor' && selected.realContent" class="toolbar-hint">using real content</span>
          </span>
          <button v-if="activeTab === 'preview'" class="toolbar-btn" data-testid="playground-reset" @click="reset" title="Reset to initial state">
            <RefreshCw class="btn-icon" aria-hidden="true" /> Reset
          </button>
          <button v-if="activeTab === 'preview'" class="toolbar-btn" data-testid="playground-toggle-inspector" @click="showInspector = !showInspector">
            <Code class="btn-icon" aria-hidden="true" /> {{ showInspector ? 'Hide' : 'Show' }} Value
          </button>
        </div>

        <!-- Tab strip — only for editors (templates). Fields skip tabs.
             Cut 6 — Impact tab is template-developer turf, not relevant
             to field-only previews. -->
        <div v-if="selected.type === 'editor'" class="playground-tabs" data-testid="playground-tabs">
          <button
            type="button"
            :class="['playground-tab', activeTab === 'preview' ? 'active' : '']"
            data-testid="playground-tab-preview"
            @click="selectTab('preview')">
            Preview
          </button>
          <button
            type="button"
            :class="['playground-tab', activeTab === 'impact' ? 'active' : '']"
            data-testid="playground-tab-impact"
            @click="selectTab('impact')">
            Impact
          </button>
        </div>

        <!-- Content: editor + optional inspector side by side, OR
             impact panel when tab=impact. Fields always render preview
             (no tab strip; the tab state is irrelevant to them). -->
        <div v-if="activeTab === 'preview' || selected.type === 'field'" class="main-body" data-testid="playground-body-preview">
          <div class="main-content">
            <div v-if="mountError" class="mount-error">{{ mountError }}</div>
            <div ref="mountRef" class="mount-container" data-testid="playground-mount" />
          </div>

          <!-- Value inspector — side panel -->
          <div v-if="showInspector" class="value-inspector" data-testid="playground-inspector">
            <div class="inspector-header">Value</div>
            <pre class="inspector-value" v-html="valueHtml" />
          </div>
        </div>

        <!-- Impact tab body. Lazy by tab activation — the panel only
             fetches when shown, so opening the playground at the
             default Preview tab pays no Impact cost. -->
        <div v-else-if="activeTab === 'impact' && selected.type === 'editor'" class="main-body main-body-impact" data-testid="playground-body-impact">
          <TemplateImpactPanel :template="selected.name" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.playground { display: flex; height: calc(100% - 60px); }

/* Sidebar */
.playground-sidebar { width: 220px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--color-border); padding: 0.75rem 0; }
.sidebar-header { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 1rem; margin-bottom: 0.75rem; color: var(--color-muted); }
.sidebar-loading { padding: 1rem; color: var(--color-muted); font-size: 0.8125rem; }
.sidebar-section { margin-bottom: 0.5rem; }
.section-label { font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); padding: 0.375rem 1rem; font-weight: 600; }
.section-label-toggle { cursor: pointer; display: flex; align-items: center; gap: 0.375rem; user-select: none; }
.section-label-toggle:hover { color: var(--color-fg); }
.toggle-icon { inline-size: 0.625rem; block-size: 0.625rem; }
.sidebar-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.3125rem 1rem; cursor: pointer; font-size: 0.8125rem; color: var(--color-muted); }
.sidebar-item:hover { background: var(--color-hover-bg); color: var(--color-fg); }
.sidebar-item.active { background: color-mix(in srgb, var(--color-primary) 10%, transparent); color: var(--color-primary); }
.item-icon { inline-size: 0.6875rem; block-size: 0.6875rem; flex-shrink: 0; }
.btn-icon { inline-size: 0.875em; block-size: 0.875em; vertical-align: -0.125em; }
.empty-icon { inline-size: 2rem; block-size: 2rem; }
.item-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sidebar-empty { padding: 1.5rem 1rem; color: var(--color-muted); font-size: 0.8125rem; line-height: 1.6; }
.sidebar-empty .hint { margin-top: 0.75rem; }
.sidebar-empty code { font-family: monospace; font-size: 0.75rem; background: var(--color-bg-code); padding: 1px 4px; border-radius: 3px; }

/* Main */
.playground-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.main-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--color-muted); font-size: 0.875rem; }
.main-toolbar { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--color-border); font-size: 0.8125rem; flex-shrink: 0; }
.toolbar-label { flex: 1; display: flex; align-items: baseline; gap: 0.5rem; color: var(--color-muted); }
.toolbar-type { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.03em; }
.toolbar-label strong { color: var(--color-fg); font-size: 0.875rem; }
.toolbar-hint { font-size: 0.6875rem; color: var(--color-muted); font-style: italic; }
.toolbar-btn { display: flex; align-items: center; gap: 0.375rem; padding: 0.25rem 0.625rem; border: 1px solid var(--color-border); border-radius: 6px; background: transparent; color: var(--color-muted); font-size: 0.75rem; cursor: pointer; white-space: nowrap; }
.toolbar-btn:hover { background: var(--color-hover-bg); color: var(--color-fg); }

/* Tabs (Cut 6) — Preview / Impact strip below the main toolbar.
   Storybook-style tab pattern; one selected at a time. */
.playground-tabs { display: flex; gap: 0; padding: 0 1rem; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.playground-tab { background: transparent; border: none; border-bottom: 2px solid transparent; padding: 0.5rem 0.75rem; font-size: 0.75rem; color: var(--color-muted); cursor: pointer; }
.playground-tab:hover { color: var(--color-fg); }
.playground-tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: 600; }

/* Body — side by side, equal width */
.main-body { flex: 1; display: flex; overflow: hidden; }
.main-body-impact { display: block; overflow-y: auto; }
.main-content { flex: 1; overflow-y: auto; padding: 1.5rem; min-width: 0; }
.mount-container { max-width: 600px; }
.mount-error { color: var(--color-danger-fg); font-size: 0.8125rem; margin-bottom: 1rem; padding: 0.75rem; background: var(--color-danger-bg); border-radius: 6px; }

/* Value inspector — equal width side panel */
.value-inspector { flex: 1; min-width: 0; border-left: 1px solid var(--color-border); background: var(--color-bg-code); overflow-y: auto; display: flex; flex-direction: column; }
.inspector-header { font-size: 0.625rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); padding: 0.5rem 0.75rem; font-weight: 600; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.inspector-value { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.75rem; line-height: 1.7; padding: 0.75rem; color: var(--color-fg); margin: 0; white-space: pre-wrap; word-break: break-word; flex: 1; }

/* JSON syntax colors */
.inspector-value .jv-key { color: var(--color-muted); }
.inspector-value .jv-str { color: var(--color-success); }
.inspector-value .jv-num { color: var(--color-warn); }
.inspector-value .jv-bool { color: var(--color-info); }
.inspector-value .jv-null { color: var(--color-muted); }

</style>
