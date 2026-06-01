<script setup lang="ts">
/**
 * CreateRedirectDialog — Manual Redirect creation UX. Per `design-redirect-ui.md`
 * Q2 (POST /api/{page,fragment}-redirects), Q3 (peer to CreatePageDialog /
 * CreateFragmentDialog), Q4 (normalize + LIVE_NAME_CONFLICT hard-refuse).
 *
 * Behavior:
 *   - Kind toggle (page | fragment) at the top — drives endpoint + autocomplete
 *   - Two inputs: "Redirect from" / "Redirect to" (parallel structure beats
 *     varied wording per impl-doc Q3)
 *   - Krug-style resolved-route preview below each input
 *   - Submit calls api.createPageRedirect / createFragmentRedirect with the
 *     verbatim input (server normalizes — strip slashes, etc.)
 *   - On 409 LIVE_NAME_CONFLICT / ALIAS_TARGET_NOT_FOUND / 400 INVALID:
 *     inline error message; dialog stays open
 *   - On 409 ARCHIVED_NAME_CONFLICT: morphs body in place to the existing
 *     ArchivedNameConflictPrompt (mirrors CreatePageDialog's pattern). The
 *     resolution (Restore / Replace / Move-aside) re-issues the POST with
 *     `?onConflict=<mode>` — Restore unarchives the existing archive;
 *     Replace purges + creates new; Move-aside renames the old archive.
 *   - Esc / Cancel button → close
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import RadioButton from 'primevue/radiobutton'
import { useRedirectsApi } from '../composables/api.js'
import { useSiteStore } from '../stores/site.js'
import {
  ArchivedNameConflictError,
  type ArchivedNameConflictDetails,
  type CreateRedirectRequest,
} from '../api/client.js'
import ArchivedNameConflictPrompt from './ArchivedNameConflictPrompt.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const site = useSiteStore()
const redirectsApi = useRedirectsApi()

const kind = ref<'page' | 'fragment'>('page')
const fromInput = ref('')
const toInput = ref('')
const creating = ref(false)
const error = ref<string | null>(null)

/**
 * Archived-name-conflict prompt state per design-soft-delete.md Q5 I3 +
 * design-redirect-ui.md Q4 (archived-name collision reuses the soft-delete
 * prompt). When the create POST returns 409 ARCHIVED_NAME_CONFLICT, the
 * dialog body morphs in place to show the three-option prompt; the outer
 * Dialog chrome stays.
 */
const conflict = ref<ArchivedNameConflictDetails | null>(null)

/**
 * Match design-redirect-ui.md Q4: derive route only for display preview;
 * the server is the authority on normalization (strips leading slashes,
 * rejects wildcards, refuses `home`). Display strips a leading slash so
 * the preview shows `/old-products` for both `old-products` and
 * `/old-products` input.
 */
function previewRoute(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const stripped = trimmed.replace(/^\/+/, '')
  return `/${stripped}`
}

const fromPreview = computed(() => previewRoute(fromInput.value))
const toPreview = computed(() => previewRoute(toInput.value))

/** Autocomplete data source: live (non-archived) items of the active
 *  kind from the site store. Operator typing the destination sees only
 *  valid alias targets (per Q4 — alias target must be live + same kind). */
const aliasTargetOptions = computed(() => {
  if (kind.value === 'page') {
    return site.pages.filter(p => !p.archived).map(p => p.name)
  }
  return site.fragments.filter(f => !f.archived).map(f => f.name)
})

const aliasTargetSuggestions = computed(() => {
  const query = toInput.value.trim().toLowerCase().replace(/^\/+/, '')
  if (!query) return aliasTargetOptions.value.slice(0, 8)
  return aliasTargetOptions.value.filter(name => name.toLowerCase().includes(query)).slice(0, 8)
})

const canSubmit = computed(
  () => !creating.value && fromInput.value.trim().length > 0 && toInput.value.trim().length > 0,
)

async function handleSubmit() {
  if (!canSubmit.value) return
  await postRedirect()
}

async function postRedirect(opts?: { onConflict?: 'restore' | 'replace' | 'moveAside' }) {
  creating.value = true
  error.value = null
  const body: CreateRedirectRequest = {
    from: fromInput.value.trim(),
    to: toInput.value.trim().replace(/^\/+/, ''),
  }
  try {
    if (kind.value === 'page') {
      await redirectsApi.createPageRedirect(body, opts)
    } else {
      await redirectsApi.createFragmentRedirect(body, opts)
    }
    await site.reload()
    emit('close')
  } catch (err) {
    if (err instanceof ArchivedNameConflictError) {
      // Morph the dialog body into the conflict prompt; keep the dialog
      // chrome open. The author resolves via Restore / Replace / Move-
      // aside; resolution re-runs `postRedirect({ onConflict: mode })`.
      conflict.value = err.archive
    } else {
      error.value = (err as Error).message
    }
  } finally {
    creating.value = false
  }
}

/**
 * Author chose Restore / Replace / Move-aside. Re-issue the create POST
 * with the chosen mode; on success close the dialog and reload the site
 * listing. On error, surface the message in place; the conflict prompt
 * stays so the author can pick differently.
 *
 * Mirrors CreatePageDialog.handleResolve — the dialog is the orchestrator;
 * the API method threads `?onConflict=...` through to the server.
 */
async function handleResolve(mode: 'restore' | 'replace' | 'moveAside') {
  await postRedirect({ onConflict: mode })
}

function handleConflictCancel() {
  conflict.value = null
  error.value = null
}

/**
 * Esc-to-close handler. Primevue's Dialog ships its own dismissal logic
 * via `update:visible`, but the dialog renders into a teleported overlay,
 * so Esc on the dialog chrome isn't always observable to wrapper tests.
 * Listening on document is the robust path + matches the user expectation
 * across all dialog states (including the morphed conflict prompt).
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.visible) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Dialog
    :visible="props.visible"
    @update:visible="emit('close')"
    modal
    :header="conflict ? 'Name conflicts with an archive' : 'New Redirect'"
    :style="{ width: conflict ? '32rem' : '28rem' }"
    data-testid="create-redirect-modal">
    <ArchivedNameConflictPrompt
      v-if="conflict"
      :archive="conflict"
      :busy="creating"
      @resolve="handleResolve"
      @cancel="handleConflictCancel" />

    <div v-else class="create-content">
      <div class="create-field create-field--kind">
        <label class="create-label-row">Kind</label>
        <div class="create-kind-row">
          <label class="create-kind-option" data-testid="create-redirect-kind-page">
            <RadioButton v-model="kind" inputId="redirect-kind-page" value="page" />
            <span>Page</span>
          </label>
          <label class="create-kind-option" data-testid="create-redirect-kind-fragment">
            <RadioButton v-model="kind" inputId="redirect-kind-fragment" value="fragment" />
            <span>Fragment</span>
          </label>
        </div>
      </div>

      <div class="create-field">
        <label class="create-label-row" for="redirect-from">Redirect from</label>
        <InputText
          id="redirect-from"
          v-model="fromInput"
          placeholder="e.g. /old-products or old-products"
          class="create-input"
          data-testid="create-redirect-from-input" />
        <span v-if="fromPreview" class="create-hint">Will redirect: {{ fromPreview }}</span>
      </div>

      <div class="create-field">
        <label class="create-label-row" for="redirect-to">Redirect to</label>
        <InputText
          id="redirect-to"
          v-model="toInput"
          :placeholder="kind === 'page' ? 'e.g. products/featured' : 'e.g. header'"
          class="create-input"
          list="redirect-target-suggestions"
          data-testid="create-redirect-to-input" />
        <!--
          Native <datalist> driven by the live-items list. Cheap autocomplete
          without pulling a new PrimeVue component; respects the kind toggle.
        -->
        <datalist id="redirect-target-suggestions">
          <option v-for="name in aliasTargetSuggestions" :key="name" :value="name" />
        </datalist>
        <span v-if="toPreview" class="create-hint">Will redirect to: {{ toPreview }}</span>
      </div>

      <p v-if="error" class="create-error" data-testid="create-redirect-error">{{ error }}</p>
    </div>

    <template v-if="!conflict" #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        data-testid="create-redirect-cancel"
        @click="emit('close')" />
      <Button
        label="Create redirect"
        icon="pi pi-plus"
        :loading="creating"
        :disabled="!canSubmit"
        data-testid="create-redirect-submit"
        @click="handleSubmit" />
    </template>
  </Dialog>
</template>

<style scoped>
.create-content { display: flex; flex-direction: column; gap: 1rem; }
.create-field { display: flex; flex-direction: column; gap: 0.375rem; }
.create-label-row { font-size: 0.75rem; text-transform: uppercase; color: var(--color-muted); letter-spacing: 0.03em; }
.create-input { width: 100%; }
.create-hint { font-size: 0.75rem; color: var(--color-muted); }
.create-error { color: var(--color-danger-fg, #f87171); font-size: 0.875rem; margin: 0; }

.create-kind-row { display: flex; gap: 1rem; align-items: center; }
.create-kind-option { display: flex; gap: 0.375rem; align-items: center; cursor: pointer; font-size: 0.875rem; }
</style>
