/**
 * Cross-framework entry point for opening the asset picker.
 *
 * React rjsf widgets (which run inside the Vue admin shell via the editor
 * mount) call this function to pop up a "select one asset" modal and get
 * the selection back as a Promise. The React side has no way to reach
 * Pinia directly; this function is the clean abstraction it depends on.
 *
 * Internals: wraps the `assetsPicker` Pinia store. Creates a Promise whose
 * resolver is handed to the store; the store fires it on confirm or cancel.
 *
 * Caller contract:
 *   const ref = await openAssetPicker({ accept: ['image'] })
 *   if (ref) onChange({ _asset: ref._asset })
 */
import { useAssetsPickerStore, type PickerOptions, type PickerRef } from '../stores/assetsPicker.js'

/**
 * Open the asset picker. Resolves with the selected reference or `null`
 * when the user cancels. Never rejects — cancellation is a Promise
 * success with a `null` value (matches the idiomatic "user dismissed
 * the dialog" contract used elsewhere in the admin).
 */
export function openAssetPicker(options: PickerOptions = {}): Promise<PickerRef | null> {
  const store = useAssetsPickerStore()
  return new Promise<PickerRef | null>(resolve => {
    store.open(options, resolve)
  })
}
