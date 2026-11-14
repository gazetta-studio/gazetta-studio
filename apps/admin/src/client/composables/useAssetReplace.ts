/**
 * The Replace file flow of the asset detail pane (design-media.md M3):
 * choosing a file, sending it, and the state AssetReplaceButton shows.
 * The done note lives only here; nothing about it is stored.
 */
import { ref } from 'vue'
import type { AssetSummary } from 'gazetta/schema'
import { AssetKindMismatchError, replaceAssetFile, type ReplacedAssetFile } from '../api/assets.js'

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
  /**
   * Bumped by every choose and dismiss: a reply that comes back after the
   * pane moved to another asset or target must not show its note there.
   */
  let current = 0

  async function choose(asset: AssetSummary, file: File): Promise<void> {
    const request = ++current
    // The browser's type is a hint; the server sniffs the bytes and has the last word.
    const fileCategory = file.type ? mimeCategory(file.type) : ''
    if (fileCategory && fileCategory !== mimeCategory(asset.mime)) {
      state.value = { kind: 'wrong-kind', fileCategory }
      return
    }
    state.value = { kind: 'working' }
    let result: ReplacedAssetFile
    try {
      result = await replaceAssetFile(asset.name, file)
    } catch (err) {
      if (request !== current) return
      state.value =
        err instanceof AssetKindMismatchError
          ? { kind: 'wrong-kind', fileCategory: err.newMimeCategory }
          : { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
      return
    }
    if (request === current)
      state.value = { kind: 'done', asset: result.manifest, perUseAltCount: result.perUseAltCount }
    // The file was replaced either way, so the list still refreshes.
    await onReplaced(result.manifest)
  }

  function dismiss(): void {
    current++
    state.value = { kind: 'idle' }
  }

  return { state, choose, dismiss }
}
