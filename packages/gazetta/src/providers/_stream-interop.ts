/**
 * Stream interoperability between Node's `stream` module and the WHATWG
 * `ReadableStream` web standard.
 *
 * Node 16.5+ provides `Readable.toWeb` / `Readable.fromWeb`, but the types
 * are subtly wrong for our use case — they return/accept the `node:stream/web`
 * variant of `ReadableStream` rather than the lib-dom global. These helpers
 * do the single-point type coercion so every consumer of the filesystem
 * provider's streaming methods (and future providers) sees the standard
 * web type without casting at each call site.
 */
import { Readable, type Writable } from 'node:stream'

/** Coerce a Node Readable into the standard `ReadableStream<Uint8Array>`. */
export function nodeReadableToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>
}

/** Coerce a standard `ReadableStream<Uint8Array>` into a Node Readable. */
export function webReadableToNode(stream: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream as import('node:stream/web').ReadableStream<Uint8Array>)
}

/**
 * Re-exported type alias — callers doing `pipeline(webReadableToNode(s), writer)`
 * need the Writable type for the writer argument, but the Node `stream` module's
 * typing is verbose to import in every provider.
 */
export type { Writable }
