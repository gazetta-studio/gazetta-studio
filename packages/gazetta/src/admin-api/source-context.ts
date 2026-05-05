/**
 * SourceContext — everything an admin-api route needs to read or write
 * source content. Bundles storage, site directory, content root, and the
 * sidecar writer into one parameter so route factories depend on a single
 * coherent concept instead of 3-4 positional arguments.
 *
 * This is the admin-api's "source" indirection. Today it wraps the ambient
 * source storage + siteDir pair; tomorrow it can be built from a
 * TargetRegistry's selected editable target with no changes to routes.
 */

import type { StorageProvider, SiteManifest } from '../types.js'
import { createContentRoot, type ContentRoot } from '../content-root.js'
import { loadSite, type Site, type LoadSiteOptions } from '../site-loader.js'
import type { TargetRegistry } from '../targets.js'
import type { HistoryProvider } from '../history.js'

export interface SourceContext {
  /** Storage provider for source reads and writes. */
  readonly storage: StorageProvider
  /**
   * Path prefix applied to storage operations — where content lives *under*
   * the storage provider. Empty string when storage is already rooted at
   * the content root (target-rooted), equal to `projectSiteDir` when storage
   * is cwd-rooted (legacy).
   * @deprecated Prefer `contentRoot.path(...)` for building content paths.
   */
  readonly siteDir: string
  /**
   * Absolute path to the project's site directory — where site.config.ts lives,
   * and the parent of `templates/` and `admin/`. Independent of storage
   * rooting: always the on-disk project path, even when the content storage
   * is target-rooted elsewhere.
   */
  readonly projectSiteDir: string
  /** Content root (storage + rooting prefix paired for path construction). */
  readonly contentRoot: ContentRoot
  /**
   * Name of the target this source resolves to, when known. Set by the
   * registry resolver; undefined for the legacy static resolver (which has
   * no named target). Routes use this to detect when a `?target=<name>`
   * query refers to the same target as the source — in which case the
   * source-side read path should be used (it can backfill sidecars).
   */
  readonly targetName?: string
  /**
   * Optional history provider for recording revisions on save. Absent
   * when history is disabled for this target (via
   * `history.enabled: false` in site.config.ts) or when history isn't
   * wired at the caller (tests, legacy setups). Save routes check for
   * presence before recording — no-op if absent.
   */
  readonly history?: HistoryProvider
  /**
   * Project-level site manifest — read once from sites/{name}/site.config.ts
   * at boot. Routes pass this to loadSite({ manifest }) so content
   * discovery works without a target-level site.config.ts.
   */
  readonly manifest?: SiteManifest
}

/**
 * Load a site from a SourceContext. Passes the project-level manifest
 * so loadSite doesn't need a target-level site config file.
 */
export function loadSiteFromSource(source: SourceContext, opts?: Partial<LoadSiteOptions>): Promise<Site> {
  return loadSite({ contentRoot: source.contentRoot, manifest: source.manifest, ...opts })
}

export interface CreateSourceContextOptions {
  storage: StorageProvider
  /** Path prefix applied to storage — see SourceContext.siteDir. */
  siteDir: string
  /** Absolute project site directory. Defaults to `siteDir` for backward compat. */
  projectSiteDir?: string
  history?: HistoryProvider
  /** Project-level site manifest — passed to loadSite so targets don't need their own site config. */
  manifest?: SiteManifest
}

export function createSourceContext(opts: CreateSourceContextOptions): SourceContext {
  return {
    storage: opts.storage,
    siteDir: opts.siteDir,
    projectSiteDir: opts.projectSiteDir ?? opts.siteDir,
    contentRoot: createContentRoot(opts.storage, opts.siteDir),
    history: opts.history,
    manifest: opts.manifest,
  }
}

/**
 * Build a HistoryProvider for a resolved target. Returns `undefined`
 * when history is disabled (via site.config.ts `history.enabled: false`).
 * Injected via `SourceContextFromRegistryOptions.buildHistory` so the
 * source-context module stays agnostic of target-config parsing — the
 * caller (admin-api boot) owns the enabled/retention decision.
 */
export type BuildHistory = (targetName: string, storage: StorageProvider) => HistoryProvider | undefined

export interface SourceContextFromRegistryOptions {
  registry: TargetRegistry
  /** Target name to use as the source. Defaults to `registry.defaultEditable()`. */
  targetName?: string
  /**
   * Path prefix applied to the target's storage. Typically `''` — most
   * registry-sourced targets are already content-rooted (filesystem provider
   * at `<siteDir>/targets/<key>`, cloud provider at a bucket).
   */
  siteDir?: string
  /**
   * Absolute project site directory — where site.config.ts lives. Required.
   * This is independent of the target's storage rooting.
   */
  projectSiteDir: string
  /** See BuildHistory — callable decides per-target history provider. */
  buildHistory?: BuildHistory
  /** Project-level site manifest. */
  manifest?: SiteManifest
}

/**
 * Construct a SourceContext from a TargetRegistry, picking the given target
 * (or the default editable target) as the source. Throws if no editable
 * target is configured and no explicit targetName is provided.
 */
export function createSourceContextFromRegistry(opts: SourceContextFromRegistryOptions): SourceContext {
  const name = opts.targetName ?? opts.registry.defaultEditable()
  const storage = opts.registry.get(name)
  return {
    ...createSourceContext({
      storage,
      siteDir: opts.siteDir ?? '',
      projectSiteDir: opts.projectSiteDir,
      history: opts.buildHistory?.(name, storage),
      manifest: opts.manifest,
    }),
    targetName: name,
  }
}

/**
 * Resolve a source for a request. Per-request indirection that lets the
 * admin API pick the content source based on the caller's requested target
 * (via `?target=<name>` query string, typically driven client-side by the
 * active-target store).
 *
 * Implementations:
 *   - Static: always returns the same SourceContext (single-target setups,
 *     tests, or the "source is target" legacy path)
 *   - Registry-backed: looks up `?target=<name>` in a TargetRegistry and
 *     builds a SourceContext from the matched target
 *
 * The resolver is called once per handler invocation; implementations can
 * memoize where appropriate.
 */
export type SourceContextResolver = (targetName: string | undefined) => SourceContext | Promise<SourceContext>

/** Static resolver — always returns the given SourceContext regardless of requested target. */
export function staticSourceResolver(source: SourceContext): SourceContextResolver {
  return () => source
}

export interface RegistrySourceResolverOptions {
  registry: TargetRegistry
  /** Required — absolute project site directory for the returned context. */
  projectSiteDir: string
  /**
   * Siteprefix to apply to the target's storage. Typically `''` since
   * registry-sourced storage is already target-rooted.
   */
  siteDir?: string
  /**
   * Optional lazy-init hook. When the registry doesn't already have a
   * provider for the requested target, the resolver calls this to build
   * one (e.g., the dev bootstrap only pre-initializes the editable local
   * target for speed; cross-target reads like `?target=staging` arrive
   * lazily). The built provider is then retrieved via `registry.get` —
   * implementations should insert it into the same provider map that
   * backs the registry view.
   */
  lazyInit?: (targetName: string) => Promise<void>
  /** See BuildHistory — callable decides per-target history provider. */
  buildHistory?: BuildHistory
  /** Project-level site manifest. */
  manifest?: SiteManifest
}

/**
 * Registry-backed resolver — picks the named target (or the registry's
 * default editable when none is named) and wraps its storage in a
 * SourceContext. Memoizes one context per target name so repeated
 * requests for the same target share the same contentRoot instance.
 */
export function registrySourceResolver(opts: RegistrySourceResolverOptions): SourceContextResolver {
  const cache = new Map<string, SourceContext>()
  return async (targetName: string | undefined) => {
    const name = targetName ?? opts.registry.defaultEditable()
    const cached = cache.get(name)
    if (cached) return cached
    // Cross-target reads may hit targets that weren't pre-initialized by
    // the bootstrap (dev only inits the editable local target by default).
    // If the target is configured but its provider hasn't been built yet,
    // let the caller lazy-init. Unknown targets (not in site.config.ts at all)
    // fall through so registry.get throws a clean UnknownTargetError.
    const isConfigured = opts.registry.list().includes(name)
    if (opts.lazyInit && isConfigured) {
      try {
        opts.registry.get(name)
      } catch {
        await opts.lazyInit(name)
      }
    }
    const ctx = createSourceContextFromRegistry({
      registry: opts.registry,
      targetName: name,
      projectSiteDir: opts.projectSiteDir,
      buildHistory: opts.buildHistory,
      siteDir: opts.siteDir,
      manifest: opts.manifest,
    })
    cache.set(name, ctx)
    return ctx
  }
}
