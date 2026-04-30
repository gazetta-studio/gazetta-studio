/**
 * Sidecar file I/O for pages and fragments — one module owning all reads
 * and writes of the two sidecar kinds:
 *
 *   .{8hex}.hash           — content hash, used by compare-targets
 *   .pub-...               — publish timestamp + noindex flag
 *
 * Filenames encode the publish-state picture — a single readDir returns
 * the full sidecar state of an item without any content reads. Scaling
 * goal: listing calls, not GETs, at 10k pages.
 *
 * Reverse dep relationships (fragment-deps, asset-refs) live in
 * `.gazetta/{relation}/{target}/{source}` per-edge sidecars (see
 * dep-sidecars.ts), not in per-item filename suffixes.
 */

import type { StorageProvider } from './types.js'
import {
  parseSidecarName,
  parseSidecarLocale,
  sidecarNameFor,
  parsePubSidecarName,
  parsePubSidecarLocale,
  pubSidecarNameFor,
  type PubSidecar,
} from './hash.js'
import { mapLimit } from './concurrency.js'

/** Full sidecar state for one page or fragment. */
export interface SidecarState {
  hash: string
  /** Publish timestamp + noindex flag. Present only on target sidecars
   *  written by the publish pipeline; absent on source-side sidecars. */
  pub: PubSidecar | null
}

/**
 * Read sidecar filenames for a single item directory. Returns null if
 * the directory doesn't exist or has no hash sidecar.
 */
export async function readSidecars(storage: StorageProvider, dir: string): Promise<SidecarState | null> {
  let entries
  try {
    entries = await storage.readDir(dir)
  } catch {
    return null
  }
  let hash: string | null = null
  let pub: PubSidecar | null = null
  for (const e of entries) {
    if (e.isDirectory) continue
    const h = parseSidecarName(e.name)
    if (h) {
      hash = h
      continue
    }
    const p = parsePubSidecarName(e.name)
    if (p) pub = p
  }
  if (!hash) return null
  return { hash, pub }
}

/**
 * Write (or rewrite) sidecars for one item, optionally locale-scoped.
 * When `locale` is set, only locale-specific sidecars (.hash.fr, .pub.fr)
 * are written/cleaned — default-locale sidecars are untouched.
 *
 * Concurrency:
 *   Calls targeting the same directory are serialized via `withDirLock`.
 *   Without serialization, Call A's cleanup phase (readDir → rm stale)
 *   would see Call B's in-flight `write-file-atomic` temp files and
 *   mistake them for stale sidecars — B's rename would then fail with
 *   ENOENT. Queueing at dir granularity eliminates the race class,
 *   matching the same idiom `write-file-atomic` itself uses per-file
 *   within a process.
 */
export async function writeSidecars(
  storage: StorageProvider,
  dir: string,
  state: SidecarState,
  locale?: string,
): Promise<void> {
  return withDirLock(dir, () => doWriteSidecars(storage, dir, state, locale))
}

async function doWriteSidecars(
  storage: StorageProvider,
  dir: string,
  state: SidecarState,
  locale?: string,
): Promise<void> {
  const want = new Set<string>([sidecarNameFor(state.hash, locale)])
  if (state.pub) want.add(pubSidecarNameFor(new Date(state.pub.lastPublished), state.pub.noindex, locale))

  // Remove stale sidecars of the SAME locale scope that aren't in `want`.
  // Safe because `withDirLock` serializes concurrent callers on this dir —
  // no other writer's atomic-write temp files can be in flight right now.
  try {
    const entries = await storage.readDir(dir)
    for (const e of entries) {
      if (want.has(e.name)) continue
      const hashLocale = parseSidecarLocale(e.name)
      const pubLocale = parsePubSidecarLocale(e.name)
      if (parseSidecarName(e.name) && hashLocale === (locale ?? undefined)) {
        try {
          await storage.rm(`${dir}/${e.name}`)
        } catch {
          /* already gone */
        }
      } else if (parsePubSidecarName(e.name) && pubLocale === (locale ?? undefined)) {
        try {
          await storage.rm(`${dir}/${e.name}`)
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* dir doesn't exist yet — mkdir below */
  }
  await storage.mkdir(dir)
  await Promise.all([...want].map(name => storage.writeFile(`${dir}/${name}`, '')))
}

/**
 * Per-directory Promise-queue serialization for `writeSidecars`.
 *
 * Single responsibility: ensure at most one `writeSidecars` call is
 * operating on a given directory at a time within this process. The
 * race we're closing:
 *
 *   Call A: readDir → sees `.hash` → rm `.hash` → writeFile new `.hash`
 *                                                      ↑ creates temp
 *   Call B (parallel):  readDir → sees A's temp file
 *                                 → matches permissive regex → rm temp
 *                                 → A's rename ENOENTs
 *
 * With serialization, B's readDir can only observe finalized state from
 * A's completed run. No temp files exist when any call does its cleanup.
 *
 * Shape: per-key Promise chain. Each caller awaits the prior Promise for
 * its key before running, and publishes its own Promise as the next
 * "current holder" for that key. Matches the pattern `write-file-atomic`
 * uses per-file (node_modules/write-file-atomic/lib/index.js, the
 * `activeFiles` map), lifted here to per-directory granularity.
 *
 * Cross-process safety: not provided — the map is in-process state.
 * Gazetta's admin is a single writer (one dev server, one publish
 * process); cross-process coordination would require a sibling `.lock`
 * file (git's pattern), which we don't need in this regime.
 */
const dirLocks = new Map<string, Promise<unknown>>()

async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve()
  const current = prev.then(fn, fn) // run `fn` whether prev resolved or rejected
  dirLocks.set(dir, current)
  try {
    return await current
  } finally {
    // Clean up the map entry only if we're still the tail of the chain.
    // Otherwise a later caller's Promise is in flight and owns the slot.
    if (dirLocks.get(dir) === current) dirLocks.delete(dir)
  }
}

/**
 * Walk a directory tree collecting every sub-directory's sidecar state.
 * Bounded-parallel recursion — flat Promise.all over 10k dirs would blow
 * the fd limit or provider rate limit.
 *
 * Keys are paths relative to `rootDir` (e.g. `home`, `blog/[slug]`). Items
 * without a .hash sidecar are skipped. `writeSidecars` always writes all
 * three kinds together, so partial state doesn't occur in real operation.
 */
export async function listSidecars(storage: StorageProvider, rootDir: string): Promise<Map<string, SidecarState>> {
  const out = new Map<string, SidecarState>()
  async function walk(dir: string, relative: string): Promise<void> {
    let entries
    try {
      entries = await storage.readDir(dir)
    } catch {
      return
    }
    // Parse sidecar state directly from the entries we already have —
    // avoids a second readDir per directory (readSidecars would re-read
    // the same dir). At 10k pages this halves the I/O calls.
    if (relative) {
      const parsed = parseSidecarEntries(entries)
      if (parsed.default) out.set(relative, parsed.default)
      for (const [loc, locState] of parsed.locales) {
        out.set(`${relative}:${loc}`, locState)
      }
    }
    const subdirs = entries.filter(e => e.isDirectory)
    await mapLimit(subdirs, e => walk(`${dir}/${e.name}`, relative ? `${relative}/${e.name}` : e.name))
  }
  await walk(rootDir, '')
  return out
}

/**
 * Parse sidecar state from already-read directory entries.
 * Returns the default-locale state plus any locale variants.
 */
function parseSidecarEntries(entries: { name: string; isDirectory: boolean }[]): {
  default: SidecarState | null
  locales: Map<string, SidecarState>
} {
  let hash: string | null = null
  let pub: PubSidecar | null = null
  const localeHashes = new Map<string, string>()
  const localePubs = new Map<string, PubSidecar>()

  for (const e of entries) {
    if (e.isDirectory) continue
    const h = parseSidecarName(e.name)
    if (h) {
      const loc = parseSidecarLocale(e.name)
      if (loc) localeHashes.set(loc, h)
      else hash = h
      continue
    }
    const p = parsePubSidecarName(e.name)
    if (p) {
      const loc = parsePubSidecarLocale(e.name)
      if (loc) localePubs.set(loc, p)
      else pub = p
    }
  }

  const defaultState: SidecarState | null = hash ? { hash, pub } : null
  const locales = new Map<string, SidecarState>()
  for (const [loc, lHash] of localeHashes) {
    locales.set(loc, { hash: lHash, pub: localePubs.get(loc) ?? null })
  }
  return { default: defaultState, locales }
}

/**
 * Walk a component tree and collect every @fragment reference, recursing
 * into inline components' children. Used when building SidecarState from
 * a live manifest (source-side).
 */
export function collectFragmentRefs(components: unknown[] | undefined): string[] {
  const refs = new Set<string>()
  function walk(entries: unknown[] | undefined): void {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.startsWith('@')) refs.add(entry.slice(1))
      else if (typeof entry === 'object' && entry !== null) {
        walk((entry as { components?: unknown[] }).components)
      }
    }
  }
  walk(components)
  return [...refs]
}
