/**
 * Asset picker — state for "select one asset and return it to the caller."
 *
 * Distinct from `assetsLibrary` (browsing) because:
 * - Browsing has no confirm/cancel resolution; picking does.
 * - Browsing has no accept filter restricting which assets are visible;
 *   picking filters by the caller's `accept` grammar.
 * - The two open/close events should not interfere — a picker opened from
 *   an rjsf widget should not affect the browsing-library's open state.
 *
 * The store holds a **resolver function** — the Promise resolver passed by
 * `openAssetPicker()`. `confirm(ref)` and `cancel()` fire it with the chosen
 * reference or `null`. If the picker closes without either action (modal
 * unmount, target switch), the modal's lifecycle should call `cancel()`
 * so the Promise always resolves and never leaks.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface PickerOptions {
  /** Accept-filter passed by the caller (from the schema's `embeddedAsset({accept})`). */
  accept?: string[]
  /** Currently-selected asset name, if any — the picker opens with this pre-selected. */
  currentAssetName?: string | null
}

export interface PickerRef {
  _asset: string
}

type PickerResolver = (ref: PickerRef | null) => void

export const useAssetsPickerStore = defineStore('assetsPicker', () => {
  const isOpen = ref(false)
  const accept = ref<string[]>([])
  const currentAssetName = ref<string | null>(null)

  let resolver: PickerResolver | null = null

  /**
   * Open the picker with the given options and resolver. Closes any in-flight
   * picker first (cancels its Promise) — only one picker is open at a time.
   */
  function open(options: PickerOptions, r: PickerResolver): void {
    // Cancel a previous picker if somehow still open (defensive — the UI
    // should prevent this, but the contract is "one active picker").
    if (resolver) {
      resolver(null)
      resolver = null
    }
    accept.value = options.accept ?? []
    currentAssetName.value = options.currentAssetName ?? null
    resolver = r
    isOpen.value = true
  }

  /** Confirm with the chosen reference; fires the resolver with `{ _asset }`. */
  function confirm(assetName: string): void {
    const r = resolver
    resolver = null
    isOpen.value = false
    if (r) r({ _asset: assetName })
  }

  /** Cancel the picker; fires the resolver with `null`. */
  function cancel(): void {
    const r = resolver
    resolver = null
    isOpen.value = false
    if (r) r(null)
  }

  return { isOpen, accept, currentAssetName, open, confirm, cancel }
})
