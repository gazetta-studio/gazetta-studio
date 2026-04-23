/**
 * Storage adapter utility — idempotent remove.
 *
 * Treats "file already gone" as a success. Every storage provider's `rm`
 * throws with a different shape — `ENOENT` on filesystem, `NoSuchKey` on
 * S3/R2, "Blob not found" on Azure. This helper folds those into a single
 * "removed (maybe already)" outcome so domain code doesn't have to
 * interpret raw provider errors.
 *
 * Why here, not in each domain module:
 * - Delete, replace, rename, and GC all want the same idempotency. The
 *   pattern belongs where the storage interface is, not in each consumer.
 * - The error-shape knowledge (which substrings mean "missing") is a
 *   provider concern. Keeping it next to the providers means a future
 *   provider that reports missing differently ships a single expansion
 *   here, not four callsite edits.
 *
 * Storage provider interface keeps `rm(path)` strict — throw on missing.
 * Callers that want idempotent semantics opt in via this helper; callers
 * that want to see the missing-file error for their own logic get it.
 */
import type { StorageProvider } from '../types.js'

/**
 * `rm(path)` that swallows "already missing" errors but propagates any
 * other failure. Returns `true` if a file was actually removed, `false`
 * if it was already gone — callers that care can distinguish.
 */
export async function rmIgnoreMissing(storage: StorageProvider, path: string): Promise<boolean> {
  try {
    await storage.rm(path)
    return true
  } catch (err) {
    if (isFileMissing(err)) return false
    throw err
  }
}

/** Does this error mean "the path doesn't exist"? Union of known provider shapes. */
function isFileMissing(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  // Keep substring matches rather than code checks — Node's fs errors expose
  // `.code`, but S3/R2/Azure errors don't share a cross-provider shape.
  // A future adapter that reports missing differently adds one more branch.
  return (
    msg.includes('ENOENT') || msg.includes('not found') || msg.includes('NoSuchKey') || msg.includes('BlobNotFound')
  )
}
