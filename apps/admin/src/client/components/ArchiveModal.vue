<!--
  ArchiveModal — confirms an archive operation with optional aliasOf
  picker and per-target capability badges.

  Per `design-soft-delete.md` Q7 J1 + Cut 10 implementation grilling
  Q4-Q5: modal opens from PageMetadataEditor's "Archive" button (or the
  ArchiveBanner's "Edit alias" action when reconfiguring an existing
  archive). The aliasOf picker is optional — leaving it empty is "pure
  soft-delete" (renders 410 / fragment-render error).

  Per-target capability badges (surface #2 of the four-point capability
  -gap UX pattern) — render a row per configured target showing whether
  it can serve 301 redirects + 410 Gone status. Plain-static targets
  show the gap reasons. Krug-aligned: only show warnings, no green
  "all good" rows that would be visual noise.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import { useArchiveStore } from '../stores/archive.js'
import { useSiteStore } from '../stores/site.js'
import { api, type TargetInfo } from '../api/client.js'

const archive = useArchiveStore()
const site = useSiteStore()

const aliasOf = ref('')
const targets = ref<TargetInfo[]>([])

const isOpen = computed(() => archive.dialogVariant === 'archive-confirm')
const item = computed(() => archive.item)
const busy = computed(() => archive.status === 'archiving')

// Reset aliasOf input when the modal opens for a new item (so a prior
// pending value doesn't leak into the next archive operation).
watch(isOpen, open => {
  if (open) {
    aliasOf.value = item.value?.currentAliasOf ?? ''
  }
})

onMounted(async () => {
  try {
    targets.value = await api.getTargets()
  } catch {
    targets.value = []
  }
})

/**
 * Targets that can't serve redirects — surface #2 per Cut 9. Renders
 * a warning row per affected target so the author sees the gap before
 * confirming.
 */
const targetsWithGaps = computed(() =>
  targets.value
    .filter(t => t.capabilities.gaps.length > 0)
    .map(t => ({
      name: t.name,
      environment: t.environment,
      gaps: t.capabilities.gaps,
    })),
)

const isPureSoftDelete = computed(() => aliasOf.value.trim().length === 0)

// Available alias targets: live pages or fragments (matching the item
// kind). The author picks one of these to set up a 301 redirect; an
// empty value means pure soft-delete.
const aliasCandidates = computed<string[]>(() => {
  if (!item.value) return []
  const live = (
    item.value.kind === 'page' ? site.pages.filter(p => !p.archived) : site.fragments.filter(f => !f.archived)
  ) as Array<{ name: string }>
  // Don't suggest the item itself as its own alias target.
  return live.map(p => p.name).filter(n => n !== item.value!.name)
})

async function handleConfirm() {
  const trimmed = aliasOf.value.trim()
  const ok = await archive.confirmArchive({ aliasOf: trimmed || undefined })
  if (ok) {
    // Refresh the site listing so the tree reflects the archived state.
    await site.load()
  }
}

function handleCancel() {
  archive.close()
}
</script>

<template>
  <Dialog
    :visible="isOpen"
    @update:visible="handleCancel"
    modal
    :header="`Archive ${item?.kind ?? ''} ${item?.name ? `&quot;${item.name}&quot;` : ''}`"
    :style="{ width: '32rem' }"
  >
    <div class="archive-content" data-testid="archive-modal">
      <p class="archive-explainer">
        Archived {{ item?.kind }}s are removed from the live site. Set an alias to redirect the old URL
        (301) to a live {{ item?.kind }}, or leave empty for pure soft-delete (the URL returns 410 Gone).
      </p>

      <div class="archive-field">
        <label for="archive-alias-input">Redirect to (optional)</label>
        <InputText
          id="archive-alias-input"
          v-model="aliasOf"
          :placeholder="`Leave empty for pure soft-delete`"
          list="archive-alias-candidates"
          class="archive-input"
          data-testid="archive-alias-input"
        />
        <datalist id="archive-alias-candidates">
          <option v-for="cand in aliasCandidates" :key="cand" :value="cand" />
        </datalist>
        <span v-if="isPureSoftDelete" class="archive-hint">
          Old URL will return 410 Gone (worker-served targets) or 404 (plain-static targets).
        </span>
        <span v-else class="archive-hint">
          Old URL will 301-redirect to <code>{{ aliasOf.trim() }}</code>.
        </span>
      </div>

      <!--
        Capability-gap surface #2 — per-target warnings only when the
        target can't fulfill the operation. Krug-aligned: absence is
        the "all good" state; only render rows that need attention.
      -->
      <div v-if="targetsWithGaps.length > 0" class="archive-gaps">
        <p class="archive-gaps-title">
          <i class="pi pi-exclamation-triangle" /> Some targets can't emit redirects
        </p>
        <ul class="archive-gaps-list">
          <li v-for="t in targetsWithGaps" :key="t.name">
            <strong>{{ t.name }}</strong> <span class="env-tag">({{ t.environment }})</span>:
            <span v-for="gap in t.gaps" :key="gap.capability" class="gap-reason">
              {{ gap.reason }}
            </span>
          </li>
        </ul>
        <p class="archive-gaps-note">
          You can still archive — see <a href="https://gazetta.studio/docs/runtime-capabilities" target="_blank" rel="noopener">runtime capabilities</a>
          for resolution paths.
        </p>
      </div>

      <p v-if="archive.errorMessage" class="archive-error">{{ archive.errorMessage }}</p>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" text :disabled="busy" data-testid="archive-cancel" @click="handleCancel" />
      <Button
        label="Archive"
        icon="pi pi-archive"
        :loading="busy"
        severity="warn"
        data-testid="archive-confirm"
        @click="handleConfirm"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.archive-content { display: flex; flex-direction: column; gap: 1rem; }
.archive-explainer { font-size: 0.875rem; color: var(--color-muted); margin: 0; }
.archive-field { display: flex; flex-direction: column; gap: 0.375rem; }
.archive-field label { font-size: 0.75rem; text-transform: uppercase; color: var(--color-muted); letter-spacing: 0.03em; }
.archive-input { width: 100%; }
.archive-hint { font-size: 0.75rem; color: var(--color-muted); }
.archive-hint code { font-family: var(--font-mono); background: var(--color-hover-bg); padding: 0 0.25rem; border-radius: 2px; }
.archive-gaps { background: var(--color-warning-bg); border: 1px solid var(--color-warning-fg); border-radius: 4px; padding: 0.75rem; }
.archive-gaps-title { margin: 0 0 0.5rem; font-weight: 600; font-size: 0.875rem; color: var(--color-warning-fg); display: flex; align-items: center; gap: 0.375rem; }
.archive-gaps-list { margin: 0; padding-left: 1.25rem; font-size: 0.8125rem; color: var(--color-fg); }
.archive-gaps-list li { margin-bottom: 0.25rem; }
.gap-reason { font-style: italic; }
.env-tag { font-size: 0.75rem; color: var(--color-muted); }
.archive-gaps-note { margin: 0.5rem 0 0; font-size: 0.75rem; color: var(--color-muted); }
.archive-error { color: var(--color-danger-fg); font-size: 0.875rem; margin: 0; }
</style>
