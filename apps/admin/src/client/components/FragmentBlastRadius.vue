<script setup lang="ts">
/**
 * "Used on N pages" badge for fragments — surfaces blast radius inline
 * while the author is editing a fragment, not only inside the publish
 * dialog. Matches design-editor-ux.md gap: "Fragment blast radius in tree
 * and editor header — currently only in PublishDialog."
 *
 * State machine: 'loading' | 'loaded' | 'error'. The badge is always
 * rendered — earlier "hidden on error" silently dropped genuine
 * failures (slow `/api/v1/dependents` on cold dev start, intermittent
 * network), leaving the user staring at empty space with no signal.
 * A visible state lets the user (or a test) tell the difference
 * between "still loading", "no dependents yet", and "load failed".
 *
 * Fetches source-side dependents (authoritative for the draft state).
 */
import { Network } from '@lucide/vue'
import { computed, ref, watch, onMounted } from 'vue'
import { useFragmentsApi } from '../composables/api.js'

const fragmentsApi = useFragmentsApi()

const props = defineProps<{
  /** Fragment name (not including the leading @). */
  fragmentName: string
  /** Compact mode — icon + count only, no "used on N pages" label.
   *  For dense lists (tree rows) where full text would wrap or clutter. */
  compact?: boolean
}>()

type State = { kind: 'loading' } | { kind: 'loaded'; pages: string[] } | { kind: 'error'; message: string }
const state = ref<State>({ kind: 'loading' })

async function load(name: string) {
  state.value = { kind: 'loading' }
  try {
    const r = await fragmentsApi.getDependents(`fragments/${name}`)
    state.value = { kind: 'loaded', pages: r.pages }
  } catch (err) {
    state.value = { kind: 'error', message: (err as Error).message }
  }
}

onMounted(() => load(props.fragmentName))
watch(
  () => props.fragmentName,
  name => load(name),
)

const tooltip = computed(() => {
  switch (state.value.kind) {
    case 'loading':
      return 'Loading dependent pages…'
    case 'error':
      return `Failed to load dependents: ${state.value.message}`
    case 'loaded':
      return state.value.pages.length > 0 ? `Used on: ${state.value.pages.join(', ')}` : 'Not used on any page yet'
  }
})

const summary = (pages: string[]) => (pages.length === 1 ? 'used on 1 page' : `used on ${pages.length} pages`)
</script>

<template>
  <span :class="['blast-radius', { compact }, `state-${state.kind}`]"
    data-testid="fragment-blast-radius"
    :data-state="state.kind"
    :title="tooltip">
    <Network class="blast-icon" aria-hidden="true" />
    <template v-if="state.kind === 'loaded'">
      <template v-if="compact">
        <span class="count">{{ state.pages.length }}</span>
      </template>
      <template v-else>
        <span v-if="state.pages.length > 0">{{ summary(state.pages) }}</span>
        <span v-else class="unused">not used yet</span>
      </template>
    </template>
    <template v-else-if="state.kind === 'loading'">
      <span v-if="compact" class="count" aria-hidden="true">…</span>
      <span v-else class="unused">loading…</span>
    </template>
    <template v-else>
      <!-- error: show a `!` (compact) or "load failed" (full) — the title
           attribute carries the actual message for hover details. -->
      <span v-if="compact" class="count error-mark" aria-hidden="true">!</span>
      <span v-else class="unused">load failed</span>
    </template>
  </span>
</template>

<style scoped>
.blast-radius {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  color: var(--color-muted);
  background: var(--color-hover-bg);
  border: 1px solid var(--color-border);
  letter-spacing: -0.01em;
}
.blast-radius .blast-icon {
  inline-size: 0.625rem;
  block-size: 0.625rem;
  flex: none;
  opacity: 0.7;
}
.blast-radius .unused {
  font-style: italic;
  opacity: 0.75;
}
.blast-radius.compact {
  padding: 0 0.25rem;
  border: 0;
  background: transparent;
  font-variant-numeric: tabular-nums;
  font-size: 0.6875rem;
}
.blast-radius.compact .count {
  font-weight: 600;
}
</style>
