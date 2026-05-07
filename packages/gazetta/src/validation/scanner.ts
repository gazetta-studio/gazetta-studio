/**
 * Background validation scanner — runs all background-stage validators across
 * the site and exposes the resulting issues to the admin API + admin UI.
 *
 * Per design-validation.md "Background scanner (Cut 2)" + the implementation
 * plan in design-validation-implementation.md:
 *
 * - Initial full-site scan on admin boot.
 * - Incremental rescan after save: affected item + transitive dependents
 *   (fragment edits invalidate pages via `findDependentsFromSidecars`; asset
 *   edits invalidate referencing items via `readRefsForAsset`; template edits
 *   trigger a full-site rescan since no `template-deps` reverse-dep relation
 *   exists yet).
 * - Per-item validation cache keyed by content hash (via `AdminCache`).
 *   Same content = same issues; cache hit short-circuits the validators.
 * - Result store keyed by item path; reads return current issues.
 * - SSE subscribers fired when a scan pass completes (admin UI dot updates).
 *
 * # Multi-instance discipline
 *
 * The scanner is per-instance scope. Each admin instance maintains its own
 * result store + cache; SSE invalidation isn't broadcast across instances.
 * Acceptable because: (a) each instance scans independently from the same
 * source-of-truth storage; (b) save-side invalidation is per-instance via
 * the same code path that wrote the manifest; (c) external changes (git
 * pull) flow through `gazetta dev`'s file watcher per-instance.
 *
 * # SOLID lenses
 *
 * - SRP: scanner orchestrates passes. It doesn't implement validators
 *   (that's per-validator) and doesn't render UI (that's the admin UI).
 * - DIP: depends on `AdminCache` interface, not `MemoryCache`; depends on
 *   the validator registry contract, not specific validators.
 * - OCP: adding a new background-stage validator means registering it in
 *   `defaultValidatorRegistry()`; the scanner picks it up automatically
 *   via `registry.forStage('background')`.
 */
import { createHash } from 'node:crypto'
import type { AdminCache } from '../cache/types.js'
import type { ContentRoot } from '../content-root.js'
import { findDependentsFromSidecars } from '../publish.js'
import type { Site, LoadSiteOptions } from '../site-loader.js'
import { allFragmentEntries, allPageEntries, loadSite } from '../site-loader.js'
import type { FragmentManifest, PageManifest, StorageProvider } from '../types.js'
import type { ValidatorRegistry } from './registry.js'
import type { Issue, SavedItem } from './types.js'

/**
 * Source of an incremental rescan. Drives which dependents the scanner
 * pulls in.
 */
export type RescanCause =
  /** Manifest of a page or fragment was saved/edited. */
  | { kind: 'manifest'; item: SavedItem }
  /** Fragment edited — the scanner walks dependents transitively. */
  | { kind: 'fragment'; name: string }
  /** Asset edited — the scanner walks the asset's referrers. */
  | { kind: 'asset'; name: string }
  /** Template source changed — full-site rescan is the fallback. */
  | { kind: 'template'; name: string }
  /** Out-of-band change detected by file watcher; full-site rescan. */
  | { kind: 'full' }

/**
 * Event published when a scan pass finishes. SSE consumers receive these.
 */
export interface ScanEvent {
  /** Wall-clock duration of the scan, ms. */
  durationMs: number
  /** Number of items the scan touched. 0 means cache-hit-only or no items. */
  scanned: number
  /** Total number of issues across the site after this scan. */
  totalIssues: number
}

export type ScanSubscriber = (event: ScanEvent) => void

export interface ValidationScanner {
  /** Run a full-site scan; updates store + cache. Idempotent. */
  scanAll(): Promise<void>
  /** Incremental rescan triggered by `cause`. */
  rescan(cause: RescanCause): Promise<void>
  /** All current issues. */
  allIssues(): readonly Issue[]
  /** Current issues for one item; empty if clean. */
  issuesFor(itemPath: string): readonly Issue[]
  /** Subscribe to scan-completed events. Returns disposer. */
  subscribe(handler: ScanSubscriber): () => void
}

export interface CreateScannerOptions {
  storage: StorageProvider
  contentRoot: ContentRoot
  registry: ValidatorRegistry
  cache: AdminCache
  /** Hook to load the site (extracted so tests can stub). */
  loadSiteImpl?: (opts: LoadSiteOptions) => Promise<Site>
  /** Site loader options used at every refresh. */
  siteOptions: Omit<LoadSiteOptions, 'contentRoot'>
}

/**
 * Construct a scanner. The scanner doesn't kick off `scanAll()` automatically;
 * callers (CLI boot path) call it after constructing.
 */
export function createValidationScanner(opts: CreateScannerOptions): ValidationScanner {
  const { storage, contentRoot, registry, cache, siteOptions } = opts
  const loadSiteFn = opts.loadSiteImpl ?? loadSite

  const issuesByItem = new Map<string, Issue[]>()
  const subscribers = new Set<ScanSubscriber>()

  function setIssues(itemPath: string, issues: readonly Issue[]) {
    if (issues.length === 0) issuesByItem.delete(itemPath)
    else issuesByItem.set(itemPath, [...issues])
  }

  function totalIssues(): number {
    let n = 0
    for (const arr of issuesByItem.values()) n += arr.length
    return n
  }

  function emit(event: ScanEvent) {
    for (const sub of subscribers) {
      try {
        sub(event)
      } catch {
        // Subscriber faults isolated; one bad subscriber doesn't block siblings.
      }
    }
  }

  async function loadFreshSite(): Promise<Site> {
    return loadSiteFn({ contentRoot, ...siteOptions })
  }

  async function validateItem(
    site: Site,
    item: SavedItem,
    manifest: PageManifest | FragmentManifest,
  ): Promise<Issue[]> {
    const hash = hashManifestStable(manifest)
    const key = cacheKey(item, hash)
    const cached = await cache.get<Issue[]>(key)
    if (cached !== null) {
      // Re-stamp the store from cache (cheap; covers boot warm-up too).
      setIssues(item.itemPath, cached)
      return cached
    }
    const validators = registry.forStage('background')
    const issues: Issue[] = []
    for (const v of validators) {
      try {
        const out = await v.validate({
          stage: 'background',
          site,
          contentRoot,
          storage,
          scope: { kind: 'background', item, manifest },
        })
        issues.push(...out)
      } catch (err) {
        // Validator threw — surface as an info issue so the scan finishes.
        issues.push({
          validator: v.name,
          severity: 'info',
          message: `Validator "${v.name}" failed: ${(err as Error).message}`,
          itemPath: item.itemPath,
        })
      }
    }
    await cache.set(key, issues)
    setIssues(item.itemPath, issues)
    return issues
  }

  async function scanAll(): Promise<void> {
    const start = Date.now()
    const site = await loadFreshSite()
    let scanned = 0

    const seen = new Set<string>()
    for (const entry of allPageEntries(site)) {
      const item: SavedItem = {
        kind: 'page',
        name: entry.name,
        itemPath: itemPathFor('page', entry.page.dir, entry.locale),
      }
      if (seen.has(item.itemPath)) continue
      seen.add(item.itemPath)
      await validateItem(site, item, entry.page)
      scanned++
    }
    for (const entry of allFragmentEntries(site)) {
      const item: SavedItem = {
        kind: 'fragment',
        name: entry.name,
        itemPath: itemPathFor('fragment', entry.fragment.dir, entry.locale),
      }
      if (seen.has(item.itemPath)) continue
      seen.add(item.itemPath)
      await validateItem(site, item, entry.fragment)
      scanned++
    }

    // Stale items in the store (deleted since last scan) get pruned.
    for (const path of [...issuesByItem.keys()]) {
      if (!seen.has(path)) issuesByItem.delete(path)
    }

    emit({ durationMs: Date.now() - start, scanned, totalIssues: totalIssues() })
  }

  async function rescan(cause: RescanCause): Promise<void> {
    if (cause.kind === 'template' || cause.kind === 'full') {
      await scanAll()
      return
    }
    const start = Date.now()
    const site = await loadFreshSite()
    let scanned = 0

    const targets = await targetsForCause(cause, site, contentRoot)
    for (const target of targets) {
      const manifest = manifestForItem(site, target)
      if (!manifest) continue // item disappeared between save and rescan
      await validateItem(site, target, manifest)
      scanned++
    }

    emit({ durationMs: Date.now() - start, scanned, totalIssues: totalIssues() })
  }

  function allIssues(): readonly Issue[] {
    const out: Issue[] = []
    for (const arr of issuesByItem.values()) out.push(...arr)
    return out
  }

  function issuesFor(itemPath: string): readonly Issue[] {
    return issuesByItem.get(itemPath) ?? []
  }

  function subscribe(handler: ScanSubscriber): () => void {
    subscribers.add(handler)
    return () => subscribers.delete(handler)
  }

  return { scanAll, rescan, allIssues, issuesFor, subscribe }
}

// ---- helpers --------------------------------------------------------------

function itemPathFor(kind: 'page' | 'fragment', dir: string, locale?: string): string {
  const base = kind === 'page' ? 'page' : 'fragment'
  const ext = locale ? `${base}.${locale}.json` : `${base}.json`
  return `${dir}/${ext}`
}

/**
 * Stable hash of a manifest for cache keying. Crypto-grade — same content =
 * same hash across processes. Different from the publish-time
 * `hashManifest()` (which folds in template + fragment hashes); the scanner
 * cares only about manifest content for invalidation purposes.
 *
 * Canonicalizes nested objects by recursively sorting keys before
 * serializing. JSON.stringify's replacer-array form only filters top-level
 * keys, which would silently miss nested mutations.
 */
function hashManifestStable(manifest: PageManifest | FragmentManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex').slice(0, 16)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
}

function cacheKey(item: SavedItem, contentHash: string): string {
  return `validation:${item.kind}:${encodePath(item.itemPath)}:${contentHash}`
}

function encodePath(path: string): string {
  return path.replace(/[/]/g, '.').replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function targetsForCause(
  cause: Exclude<RescanCause, { kind: 'template' } | { kind: 'full' }>,
  site: Site,
  contentRoot: ContentRoot,
): Promise<readonly SavedItem[]> {
  if (cause.kind === 'manifest') return [cause.item]

  if (cause.kind === 'fragment') {
    // Affected: the fragment itself + every page/fragment that references it.
    const out: SavedItem[] = []
    const frag = site.fragments.get(cause.name)
    if (frag) {
      out.push({ kind: 'fragment', name: cause.name, itemPath: `${frag.dir}/fragment.json` })
    }
    const dependents = await findDependentsFromSidecars(contentRoot, { fragment: cause.name })
    for (const pageName of dependents.pages) {
      const page = site.pages.get(pageName)
      if (page) out.push({ kind: 'page', name: pageName, itemPath: `${page.dir}/page.json` })
    }
    for (const fragName of dependents.fragments) {
      const f = site.fragments.get(fragName)
      if (f) out.push({ kind: 'fragment', name: fragName, itemPath: `${f.dir}/fragment.json` })
    }
    return out
  }

  if (cause.kind === 'asset') {
    // readRefsForAsset would re-introduce a coupling we don't want here;
    // for v1, treat asset edits as full-site rescan. The cost is low at
    // envelope (5K pages x ~10ms validate per item = 50s worst case;
    // typical scans are <1s thanks to cache hits).
    const out: SavedItem[] = []
    for (const entry of allPageEntries(site)) {
      out.push({ kind: 'page', name: entry.name, itemPath: itemPathFor('page', entry.page.dir, entry.locale) })
    }
    return out
  }

  // Unreachable per type guards above.
  return []
}

function manifestForItem(site: Site, item: SavedItem): PageManifest | FragmentManifest | null {
  if (item.kind === 'page') return site.pages.get(item.name) ?? null
  return site.fragments.get(item.name) ?? null
}
