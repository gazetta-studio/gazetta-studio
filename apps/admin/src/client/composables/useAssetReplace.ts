/**
 * The Replace file flow of the asset detail pane (design-media.md M3):
 * choosing a file, sending it, and the state AssetReplaceButton shows.
 * The done note lives only here; nothing about it is stored.
 */
import { ref } from 'vue'
import type { AssetSummary } from 'gazetta/schema'
import { AssetKindMismatchError, replaceAssetFile } from '../api/assets.js'

export type ReplaceState =
  | { kind: 'idle' }
  | { kind: 'wrong-kind'; fileCategory: string }
  | { kind: 'working' }
  | { kind: 'done'; asset: AssetSummary; perUseAltCount: number }
  | { kind: 'failed'; reason: string }

/** `image/png` → `image`. */
export function mimeCategory(mime: string): string {
  const slash = mime.indexOf('/')
  return slash === -1 ? mime : mime.slice(0, slash)
}

export function useAssetReplace(onReplaced: (asset: AssetSummary) => Promise<void> | void) {
  const state = ref<ReplaceState>({ kind: 'idle' })

  async function choose(asset: AssetSummary, file: File): Promise<void> {
    // The browser's type is a hint; the server sniffs the bytes and has the last word.
    const fileCategory = file.type ? mimeCategory(file.type) : ''
    if (fileCategory && fileCategory !== mimeCategory(asset.mime)) {
      state.value = { kind: 'wrong-kind', fileCategory }
      return
    }
    state.value = { kind: 'working' }
    let replaced: AssetSummary
    try {
      const result = await replaceAssetFile(asset.name, file)
      replaced = result.manifest
      state.value = { kind: 'done', asset: replaced, perUseAltCount: result.perUseAltCount }
    } catch (err) {
      state.value =
        err instanceof AssetKindMismatchError
          ? { kind: 'wrong-kind', fileCategory: err.newMimeCategory }
          : { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
      return
    }
    await onReplaced(replaced)
  }

  function dismiss(): void {
    state.value = { kind: 'idle' }
  }

  return { state, choose, dismiss }
}
