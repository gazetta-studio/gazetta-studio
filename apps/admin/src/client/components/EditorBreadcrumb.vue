<script setup lang="ts">
/**
 * Breadcrumb shown above the editor body in edit mode (#82).
 *
 * Replaces the previous `<h3>{{ editing.template }}</h3>` header which
 * showed developer-jargon template names like "hero" or "feature-card"
 * — content authors don't know what those mean. The breadcrumb shows
 * the user-set component names that match what they see in the
 * ComponentTree, with each segment clickable to navigate up.
 *
 * Examples:
 *   - Page root selected:                 home
 *   - Top-level component on page:        home  >  hero
 *   - Nested inline component:            home  >  features  >  fast
 *   - Fragment edit (root):               @header
 *   - Component inside fragment:          @header  >  nav  >  link-list
 *
 * Click behavior:
 *   - Last segment is non-clickable (current position)
 *   - Earlier segments push to the corresponding URL hash. The router
 *     beforeEach guard runs the standard unsaved-changes flow if the
 *     navigation would discard pending edits — same as ComponentTree
 *     row clicks, no new guard surface.
 *
 * Locale awareness: the active locale is already shown in the top-bar
 * locale picker; the breadcrumb stays simple and doesn't duplicate it.
 *
 * Truncation: at the operating envelope (depth typically < 5), the
 * full breadcrumb fits. Long paths hit the parent's overflow:hidden
 * ellipsis at v1; middle-segment truncation lands when concrete
 * pain surfaces.
 *
 * # SOLID lenses
 *
 *   - SRP: this component renders one breadcrumb derived from the
 *     editing store + selection store. Navigation through a hash
 *     change is delegated to vue-router; the unsaved-changes guard
 *     is delegated to the router beforeEach.
 *   - DIP: depends on the typed editing/selection stores; doesn't
 *     reach into manifest-walking code.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useEditingStore } from '../stores/editing.js'
import { useSelectionStore } from '../stores/selection.js'

interface Segment {
  /** Display label (component name or @fragmentName or page name). */
  label: string
  /**
   * Hash to navigate to when clicked. `null` for the current
   * (last) segment, which renders as plain text.
   */
  hash: string | null
}

const editing = useEditingStore()
const selection = useSelectionStore()
const router = useRouter()

const segments = computed<Segment[]>(() => {
  const sel = selection.selection
  if (!sel) return []

  const out: Segment[] = []

  // First segment: the page or fragment itself. Fragment context
  // shows `@name` to match the syntax used in component manifests +
  // ComponentTree rendering.
  const rootLabel = sel.type === 'page' ? sel.name : `@${sel.name}`
  // Root is clickable when we're not currently AT the root (i.e.,
  // there's at least one component segment after it). Three "root"
  // shapes:
  //   - page root: editing.path === '_root'
  //   - fragment root: editing.path === '@<name>'
  //   - no editor open: editing.path null/empty
  const path = editing.path
  const onFragmentRoot = sel.type === 'fragment' && path === `@${sel.name}`
  const atRoot = path === '_root' || path === null || path === '' || onFragmentRoot
  out.push({
    label: rootLabel,
    hash: atRoot ? null : '', // empty hash = root selection
  })

  // Component path: 'features/fast' → ['features', 'fast'], each
  // clickable except the last. _root is excluded from segments
  // (it's the root marker, already rendered above). Fragment-edit
  // path '@name' is also excluded (the fragment itself IS root).
  if (path && path !== '_root' && !path.startsWith('@')) {
    const parts = path.split('/').filter(Boolean)
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      const isLast = i === parts.length - 1
      out.push({
        label: parts[i],
        hash: isLast ? null : `#${acc}`,
      })
    }
  }

  return out
})

function navigate(hash: string) {
  // Plain string hash form — vue-router's withPersistentQuery wrapper
  // (router.ts) parses + preserves locale/target query params. The
  // beforeEach guard handles unsaved edits via useUnsavedGuardStore.
  // Empty string = navigate to current path with no hash (root).
  router.push({ path: router.currentRoute.value.path, hash, query: router.currentRoute.value.query })
}
</script>

<template>
  <nav v-if="segments.length > 0" class="editor-breadcrumb" aria-label="Editor location" data-testid="editor-breadcrumb">
    <template v-for="(seg, idx) in segments" :key="idx">
      <span v-if="idx > 0" class="separator" aria-hidden="true">›</span>
      <button
        v-if="seg.hash !== null"
        type="button"
        class="segment segment-link"
        :data-testid="`breadcrumb-segment-${seg.label}`"
        @click="navigate(seg.hash)">
        {{ seg.label }}
      </button>
      <span v-else class="segment segment-current" :data-testid="`breadcrumb-segment-${seg.label}`" aria-current="location">
        {{ seg.label }}
      </span>
    </template>
  </nav>
</template>

<style scoped>
.editor-breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8125rem;
  line-height: 1.25;
  color: var(--color-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0;
  min-width: 0;
}
.separator {
  color: var(--color-muted);
  opacity: 0.6;
  flex-shrink: 0;
}
.segment {
  background: transparent;
  border: none;
  font: inherit;
  color: inherit;
  padding: 0.125rem 0.25rem;
  border-radius: var(--p-border-radius-sm);
  cursor: default;
}
.segment-link {
  cursor: pointer;
  color: var(--color-muted);
}
.segment-link:hover {
  background: var(--color-hover-bg);
  color: var(--color-fg);
}
.segment-link:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 1px;
}
.segment-current {
  color: var(--color-fg);
  font-weight: 600;
}
</style>
