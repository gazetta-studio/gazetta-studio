/**
 * Upload prompt — modal state for "default vs override" decision.
 *
 * Flow:
 *   1. User drops a file into the library while a non-default locale is active
 *   2. Upload zone derives the name; if the name matches an existing asset's
 *      default manifest, ambiguity exists: are they replacing the default, or
 *      adding a French/Arabic/etc. override?
 *   3. The zone calls `prompt(file, name, locale)` and awaits the user's choice
 *   4. The modal opens, user picks: replace-default / add-override / cancel
 *   5. The Promise resolves with the choice; the zone proceeds (or doesn't)
 *
 * The store holds at most one prompt in flight — the modal serializes the
 * decision. While a prompt is open, additional drops are still derived
 * but each one creates its own Promise and queues behind the active modal
 * (the modal closes on choice; the next prompt then opens). Implementation
 * keeps this simple: only the most recent prompt is rendered; previously
 * queued prompts resolve to 'cancel' if displaced.
 *
 * Distinct from `assetsUpload`: this store decides WHAT to do; that store
 * actually does it. Splitting the modal-state from the upload-state keeps
 * the upload pipeline reusable from non-prompt code paths (the picker's
 * inline upload, future bulk-upload, etc.).
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** What the user chose in the prompt. */
export type UploadPromptChoice = 'replace-default' | 'add-override' | 'cancel'

export interface UploadPromptInput {
  /** The file being uploaded (for size + name display). */
  file: File
  /** Asset name derived from the file (matches an existing default asset). */
  name: string
  /** Active locale at the time the prompt was triggered. Always non-default. */
  locale: string
  /** Default-locale label for copy ("English" instead of "en"). Optional. */
  defaultLocaleLabel?: string
  /** Active-locale label for copy ("French" instead of "fr"). Optional. */
  activeLocaleLabel?: string
}

type Resolver = (choice: UploadPromptChoice) => void

export const useAssetsUploadPromptStore = defineStore('assetsUploadPrompt', () => {
  const isOpen = ref(false)
  const current = ref<UploadPromptInput | null>(null)
  let resolver: Resolver | null = null

  /**
   * Open the prompt and return a Promise that resolves to the user's
   * choice. The caller awaits and branches on the result.
   *
   * If a prompt is already open, the previous prompt resolves with
   * 'cancel' and the new one takes over — keeps the model simple
   * (one decision-modal at a time, no queue depth surprises).
   */
  function prompt(input: UploadPromptInput): Promise<UploadPromptChoice> {
    if (resolver) {
      // Displace the previous prompt — resolve it cancel before swapping.
      resolver('cancel')
    }
    return new Promise<UploadPromptChoice>(resolve => {
      resolver = resolve
      current.value = input
      isOpen.value = true
    })
  }

  /** User picked one of the choices. Fire the resolver and close. */
  function pick(choice: UploadPromptChoice): void {
    const r = resolver
    resolver = null
    isOpen.value = false
    current.value = null
    if (r) r(choice)
  }

  /** User dismissed (escape, click outside) — equivalent to cancel. */
  function dismiss(): void {
    pick('cancel')
  }

  return { isOpen, current, prompt, pick, dismiss }
})
