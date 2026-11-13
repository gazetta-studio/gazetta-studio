import { rmIgnoreMissing } from '../providers/_rm-ignore-missing.js'
import type { StorageProvider } from '../types.js'

/**
 * Remove the files a failed write committed before it failed. Errors are
 * swallowed: the caller's original error is what matters, and a file left
 * behind is an orphan that GC reclaims, not a broken asset.
 */
export async function rollback(storage: StorageProvider, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rmIgnoreMissing(storage, path)
    } catch {
      /* best-effort */
    }
  }
}
