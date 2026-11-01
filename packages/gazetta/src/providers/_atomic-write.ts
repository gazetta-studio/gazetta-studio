/**
 * Atomic file write policy for the filesystem provider.
 *
 * Both text and binary-stream writes use a write-then-rename strategy so
 * readers mid-write never see a partial file:
 *
 * - Text (`atomicWriteString`): delegates to the `write-file-atomic` package
 *   (same pattern everyone else in the Node ecosystem uses — sharp's internal
 *   config, npm's lockfile writer, etc.).
 * - Binary stream (`atomicWriteStream`): pipes the incoming stream into a
 *   same-directory temp file, then renames onto the target. Temp is cleaned
 *   up on pipeline failure.
 *
 * Atomicity guarantees:
 * - POSIX `rename(2)` is atomic within a single filesystem. Node's
 *   `fs.rename` delegates to it on POSIX systems.
 * - Windows `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` is atomic on NTFS
 *   when source and target are on the same volume — write-file-atomic (for
 *   text) and our temp-path scheme (for streams) both place the temp file
 *   in the same directory as the target to meet this requirement.
 *
 * This module is filesystem-specific. Cloud storage (R2, S3, Azure) has
 * naturally atomic single-object PUT and does not need this policy.
 */
import { createWriteStream } from 'node:fs'
import { link, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import writeFileAtomic from 'write-file-atomic'
import { StorageConditionalFailedError } from '../storage-errors.js'
import { webReadableToNode, type Writable } from './_stream-interop.js'

export async function atomicWriteString(path: string, content: string): Promise<void> {
  // Parent directory must exist before write-file-atomic creates its tempfile
  // next to the target. Same contract as atomicWriteStream.
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, content, 'utf-8')
}

/**
 * Create `path` with `content` only if it doesn't exist (#1554), throwing
 * `StorageConditionalFailedError` if it does. The content goes to a temp
 * file first and is then hard-linked into place: `link(2)` fails with
 * EEXIST when the target exists and is atomic, so of two writers only one
 * wins, an existing file is never replaced, and readers never see a
 * partial file (which writing the target with `wx` directly would allow).
 */
export async function atomicCreateString(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'wx' })
    await link(tmpPath, path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageConditionalFailedError(path, { cause: err })
    throw err
  } finally {
    await rm(tmpPath, { force: true })
  }
}

/**
 * Atomic byte write — bytes-in, no string round-trip. Used by callers
 * that have a buffer in hand (history blobs, bounded asset writes).
 * Same write-then-rename guarantees as atomicWriteString.
 */
export async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // write-file-atomic accepts Buffer | Uint8Array directly; no encoding
  // applied when the second arg is bytes. Wrap in Buffer for consistent
  // typing across Node versions (Buffer extends Uint8Array).
  await writeFileAtomic(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

export async function atomicWriteStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  // Parent directory must exist before createWriteStream can create the file.
  // (`write-file-atomic` handles this for text; for streams we do it ourselves.)
  await mkdir(dirname(path), { recursive: true })

  const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const writer = createWriteStream(tmpPath)

  try {
    await pipeline(webReadableToNode(stream), writer as Writable)
  } catch (err) {
    // Clean up the temp file on pipeline failure; swallow rm errors
    // (already-missing temp is fine).
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  try {
    await rename(tmpPath, path)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
}
