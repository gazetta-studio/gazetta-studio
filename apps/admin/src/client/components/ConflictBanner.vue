<script setup lang="ts">
/**
 * Save-conflict banner per `design-offline.md` Q3 + Q4. Surfaces when
 * the active item has a conflict (the server's etag changed between
 * the author's read and write — typically because someone else saved,
 * or the file was edited out-of-band).
 *
 * Two actions per the locked Krug-aligned UX:
 *
 *   - "Show what changed" → opens the diff view (ConflictDiffView)
 *   - "Discard my changes" → drops local pending edits + clears the
 *                            conflict; banner closes; editor reloads
 *                            the server's current version
 *
 * **No "Save anyway / Overwrite" action** per design-offline.md Q3:
 * authors who genuinely want to overwrite specific changes manually
 * port their edits onto the new version. Overwrite-without-review
 * is a footgun.
 *
 * Plain language: "Was edited by someone else" — not "STALE" or
 * "etag mismatch." Author-facing copy stays Krug-clean.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import { useSaveConflictsStore } from '../stores/saveConflicts.js'
import ConflictDiffView from './ConflictDiffView.vue'

const props = defineProps<{
  /**
   * Manifest path the editor is currently viewing. Banner shows only
   * when this path has a conflict registered.
   */
  itemPath: string
}>()

const emit = defineEmits<{
  /** Author chose "Discard my changes." Editor should reload from
   *  the server's current. The parent owns the reload mechanics. */
  discard: []
}>()

const conflicts = useSaveConflictsStore()
const conflict = computed(() => conflicts.get(props.itemPath))

const showingDiff = ref(false)

function showDiff(): void {
  showingDiff.value = true
}

function hideDiff(): void {
  showingDiff.value = false
}

function discard(): void {
  conflicts.clear(props.itemPath)
  emit('discard')
}
</script>

<template>
  <div
    v-if="conflict"
    class="conflict-banner"
    role="alert"
    data-testid="conflict-banner">
    <div class="banner-header">
      <i class="pi pi-exclamation-triangle banner-icon" aria-hidden="true" />
      <span class="banner-title">Was edited by someone else</span>
    </div>
    <p class="banner-body">
      A newer version of this content is on the server. Your changes
      weren't saved.
    </p>
    <div class="banner-actions">
      <Button
        size="small"
        severity="secondary"
        label="Show what changed"
        data-testid="conflict-banner-show-diff"
        @click="showDiff" />
      <Button
        size="small"
        severity="danger"
        outlined
        label="Discard my changes"
        data-testid="conflict-banner-discard"
        @click="discard" />
    </div>

    <ConflictDiffView
      v-if="showingDiff"
      :current="conflict.current"
      :pending="conflict.pending"
      data-testid="conflict-diff-view"
      @close="hideDiff" />
  </div>
</template>

<style scoped>
.conflict-banner {
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
  border: 1px solid var(--color-warning-fg);
  border-radius: var(--p-border-radius-md);
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}
.banner-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
}
.banner-icon {
  font-size: 1.1rem;
}
.banner-body {
  margin: 0.5rem 0 0.75rem;
  font-size: 0.875rem;
}
.banner-actions {
  display: flex;
  gap: 0.5rem;
}
</style>
