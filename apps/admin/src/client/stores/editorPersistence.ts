import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { EditingTarget } from './editorContent.js'
import type { StashedEdit } from './editorStash.js'
import { ValidationFailedError } from '../api/client.js'

export interface SaveResult {
  success: boolean
  error?: string
  /**
   * Set when the server returned 409 VALIDATION_FAILED. Carries structured
   * issues for the banner UI; the route handler in useEditorActions reads
   * this to populate the `validationIssues` store rather than firing a
   * generic error toast.
   */
  validationError?: ValidationFailedError
}

/**
 * One pending structural write — a closure that POSTs the new components array
 * to the page or fragment endpoint. The caller (useEditorActions) closes over
 * the manifest key + current pending array and supplies the closure here so
 * persistence stays HTTP-agnostic.
 */
export interface StructuralWrite {
  /** Diagnostic label for error messages — e.g. "page:home" or "fragment:header". */
  label: string
  write(): Promise<void>
}

/**
 * Save orchestration — persists the current edit, all stashed edits, and any
 * pending structural writes by calling each target's save function in turn.
 *
 * Pure orchestration — no side effects (no toasts, no preview invalidation).
 * The caller decides what to do with the result.
 */
export const useEditorPersistenceStore = defineStore('editorPersistence', () => {
  const saving = ref(false)
  const lastSaveError = ref<string | null>(null)

  /**
   * Persist the current edit, all stashed edits, and all structural writes.
   *
   * Calls writers sequentially in the order: current content edit, stashed
   * content edits, structural writes. Returns success/error. On success, the
   * caller is responsible for clearing stash + structural state and updating
   * the saved baseline.
   */
  async function save(
    current: { target: EditingTarget; content: Record<string, unknown> } | null,
    stashedEdits: StashedEdit[],
    structuralWrites: StructuralWrite[] = [],
  ): Promise<SaveResult> {
    if (!current && stashedEdits.length === 0 && structuralWrites.length === 0) {
      return { success: true }
    }
    saving.value = true
    lastSaveError.value = null
    try {
      if (current) await current.target.save(current.content)
      for (const entry of stashedEdits) await entry.target.save(entry.editedContent)
      for (const sw of structuralWrites) await sw.write()
      return { success: true }
    } catch (err) {
      const message = (err as Error).message
      lastSaveError.value = message
      if (err instanceof ValidationFailedError) {
        return { success: false, error: message, validationError: err }
      }
      return { success: false, error: message }
    } finally {
      saving.value = false
    }
  }

  return { saving, lastSaveError, save }
})
