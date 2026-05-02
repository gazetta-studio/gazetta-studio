<script setup lang="ts">
/**
 * Three-state alt editor — used in the asset detail pane and reusable
 * elsewhere (future: picker reference-options panel).
 *
 * Three states surfaced as two affordances:
 *   - text input — meaningful description
 *   - "Decorative" checkbox — alt = "" (skipped by screen readers)
 *
 * Combined behavior:
 *   - decorative checked + any input  → '' (decorative)
 *   - decorative unchecked + non-empty → trimmed string
 *   - decorative unchecked + empty    → null (not set)
 *
 * Commits on blur of the text input or change of the checkbox. The
 * server PATCH is non-blocking; the parent decides whether to refresh
 * the asset list. We emit `update` with the new value and let the
 * parent persist — keeps this component pure-presentation.
 */
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  /** Current alt value from the asset's manifest. Three-state. */
  modelValue: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void
}>()

// Local edit state mirrors the prop — committed values flow back via emit.
const text = ref(props.modelValue && props.modelValue.length > 0 ? props.modelValue : '')
const decorative = ref(props.modelValue === '')

watch(
  () => props.modelValue,
  newValue => {
    text.value = newValue && newValue.length > 0 ? newValue : ''
    decorative.value = newValue === ''
  },
)

const stateLabel = computed(() => {
  if (decorative.value) return 'Decorative — skipped by screen readers'
  if (text.value.length === 0) return 'Not set — admin will warn'
  return ''
})

function commitText(event: Event): void {
  const v = (event.target as HTMLInputElement).value.trim()
  text.value = v
  if (decorative.value) return // decorative wins
  emit('update:modelValue', v === '' ? null : v)
}

function toggleDecorative(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  decorative.value = checked
  if (checked) {
    emit('update:modelValue', '')
  } else {
    // Toggling off: revert to whatever the input holds.
    emit('update:modelValue', text.value === '' ? null : text.value)
  }
}
</script>

<template>
  <div class="alt-editor" data-testid="alt-editor">
    <input
      type="text"
      class="alt-input"
      placeholder="Describe the image (alt text for accessibility)"
      :value="text"
      :disabled="decorative"
      data-testid="alt-editor-input"
      @blur="commitText" />
    <label class="alt-decorative">
      <input
        type="checkbox"
        :checked="decorative"
        data-testid="alt-editor-decorative"
        @change="toggleDecorative" />
      Decorative
    </label>
    <p v-if="stateLabel" class="alt-state" data-testid="alt-editor-state">{{ stateLabel }}</p>
  </div>
</template>

<style scoped>
.alt-editor {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.alt-input {
  font: inherit;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--p-form-field-border-color);
  border-radius: 4px;
  background: var(--p-form-field-background);
  color: var(--p-text-color);
}

.alt-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.alt-decorative {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
}

.alt-state {
  margin: 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}
</style>
