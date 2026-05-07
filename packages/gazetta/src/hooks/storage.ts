/**
 * Read-only storage view for HookContext.
 *
 * Per design-hooks.md "Mutation rules" #6: hooks can read but not
 * write storage. Writes go through the operation that fired the
 * hook (mutating the returned payload). Prevents hook-vs-operation
 * write races.
 *
 * # Why a separate type, not a Proxy at this stage
 *
 * Cut 1 ships TYPES only. The dispatcher (Cut 2) constructs the
 * read-only view at HookContext build time — design open question 2
 * recommends a Proxy implementation for less code duplication, but
 * the TYPE we expose to handlers is a structural subset of
 * `StorageProvider`. Whether the runtime uses Proxy filtering or a
 * dedicated wrapper class is the dispatcher's concern; the type
 * stays narrow either way.
 *
 * # Why narrow, not extending StorageProvider
 *
 *   - SRP: hooks don't need write APIs. Exposing them via Pick<>
 *     would require hooks to know which methods are forbidden.
 *   - LSP: a hook receiving `ReadOnlyStorageProvider` can't acci-
 *     dentally pass it to a function expecting full `StorageProvider`
 *     and have a runtime mutation succeed.
 *   - Forward-compatible: future read-only methods (e.g., `stat()`)
 *     extend this type; write methods stay on the full
 *     `StorageProvider`.
 */
import type { DirEntry, ByteRange } from '../types.js'

/**
 * Read-only subset of `StorageProvider`. Hooks consuming this type
 * cannot write — `writeFile`, `writeBytes`, `writeStream`, `mkdir`,
 * `rm` are all absent.
 */
export interface ReadOnlyStorageProvider {
  readFile(path: string): Promise<string>
  readDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  readBytes(path: string): Promise<Uint8Array>
  readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>
}
