/** Output of a rendered component */
export interface RenderOutput {
  html: string
  css: string
  js: string
  head?: string
}

/** Template function signature — generic over content type */
export type TemplateFunction<T extends Record<string, unknown> = Record<string, unknown>> = (params: {
  content?: T
  children?: RenderOutput[]
  params?: Record<string, string>
  /** Active locale code (e.g. 'fr', 'en'). Always provided by the renderer — defaults to site's locale or 'en'. */
  locale: string
}) => RenderOutput | Promise<RenderOutput>

/** Mount function for framework-agnostic custom editors */
export interface EditorMount {
  mount(
    el: HTMLElement,
    props: {
      content: Record<string, unknown>
      schema: Record<string, unknown>
      theme: 'dark' | 'light'
      onChange: (content: Record<string, unknown>) => void
      /** Base URL for loading custom field modules (dev mode: /@fs/ path) */
      fieldsBaseUrl?: string
      /**
       * Asset picker callback — used by embedded-asset field widgets to
       * open a "select one asset" modal. Admin supplies its own
       * implementation (Vue-rendered in the admin); the editor package
       * depends only on the abstract Promise-returning shape.
       *
       * Returns `{ _asset: name }` on confirm, `null` on cancel.
       */
      onPickAsset?: (options: {
        accept?: string[]
        currentAssetName?: string | null
      }) => Promise<{ _asset: string } | null>
    },
  ): void
  unmount(el: HTMLElement): void
}

/** Mount function for framework-agnostic custom field widgets */
export interface FieldMount {
  mount(
    el: HTMLElement,
    props: {
      value: unknown
      schema: Record<string, unknown>
      theme: 'dark' | 'light'
      onChange: (value: unknown) => void
    },
  ): void
  unmount(el: HTMLElement): void
}

/** Template module — what a template file exports */
export interface TemplateModule {
  default: TemplateFunction
  schema: unknown // ZodType — kept as unknown to avoid zod dependency in shared
}

/** Inline component — nested within a page or fragment manifest */
export interface InlineComponent {
  name: string
  template: string
  content?: Record<string, unknown>
  components?: ComponentEntry[]
}

/** A component entry is either a fragment reference string ("@header") or an inline component object */
export type ComponentEntry = string | InlineComponent

/** Component manifest (base) */
export interface ComponentManifest {
  template: string
  content?: Record<string, unknown>
  components?: ComponentEntry[]
}

/** Fragment manifest (shared component) */
export interface FragmentManifest extends ComponentManifest {}

/** CDN cache purge configuration */
export interface PurgeConfig {
  type: 'cloudflare'
  /** API token with cache purge permission — use ${ENV_VAR} syntax */
  apiToken?: string
  /** Zone ID — auto-detected from siteUrl when not set */
  zoneId?: string
}

/** Cache configuration */
export interface CacheConfig {
  /** Browser cache TTL in seconds (max-age). Default: 0 */
  browser?: number
  /** Edge/CDN cache TTL in seconds (s-maxage). Default: 86400 */
  edge?: number
  /** CDN cache purge configuration */
  purge?: PurgeConfig
}

/** SEO metadata for a page — surfaced in <head> and used by sitemap generation. */
export interface PageMetadata {
  title?: string
  description?: string
  ogImage?: string
  canonical?: string
  /** Robots directive — e.g. "noindex", "nofollow", "noindex, nofollow".
   *  When set, emitted as `<meta name="robots" content="...">`.
   *  When absent, the tag is omitted (default: allow indexing). */
  robots?: string
}

/** Page manifest (routable component) */
export interface PageManifest extends ComponentManifest {
  route: string
  metadata?: PageMetadata
  cache?: CacheConfig
}

/** Storage configuration */
export interface StorageConfig {
  type: 'filesystem' | 'azure-blob' | 's3' | 'r2'
  /**
   * Filesystem storage directory, relative to the site directory.
   * Defaults to `./targets/<target-key>` when unset — the target's key in
   * site.yaml maps to a subdirectory under `targets/`. Override for shared
   * drives, external mounts, or existing custom layouts.
   */
  path?: string
  connectionString?: string
  container?: string
  endpoint?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  region?: string
  accountId?: string
}

/** Worker/runtime configuration */
export interface WorkerConfig {
  type: 'cloudflare'
  name?: string
}

export type TargetEnvironment = 'local' | 'staging' | 'production'

export type TargetType = 'static' | 'dynamic'

/** Target configuration in site.yaml */
export interface TargetConfig {
  storage: StorageConfig
  worker?: WorkerConfig
  /**
   * Rendering model:
   * - `static`: pre-rendered at publish time, served from edge (no SSR at request)
   * - `dynamic`: composed/SSR'd at request time on Node/Bun server (ESI-style assembly)
   * Default: `dynamic` if worker configured, `static` otherwise.
   */
  type?: TargetType
  /**
   * Semantic intent of this target — drives UI treatment (confirmation
   * prompts, badges) and ops decisions. Default: 'local'. Production
   * targets must be marked explicitly — the default is safe, not
   * alarming; prod opt-in prevents accidental prod chrome on dev targets.
   */
  environment?: TargetEnvironment
  /**
   * Whether the author can save form-edits to this target and whether it
   * can receive publishes from the CMS. Default: `true` for `environment:
   * local` (or unset — local is the env default), `false` for `staging`
   * and `production`.
   * Override explicitly for hotfix-tolerant staging/prod setups
   * (`editable: true`) or locked-down local targets (`editable: false`).
   */
  editable?: boolean
  /** Base URL of the site (e.g. https://gazetta.studio) */
  siteUrl?: string
  /**
   * Locale subset this target serves. Inherits site-level `locales.supported`
   * when absent. A single-entry list (e.g. `[fr]`) makes the target
   * single-language — no URL prefix, no locale switching.
   */
  locales?: string[]
  /**
   * Default locale for this target. Inherits site-level `locale` when absent.
   * The default locale has no URL prefix (unless `defaultPrefix` is true).
   * For single-locale targets, auto-inferred from the `locales` list.
   */
  locale?: string
  /**
   * Override site-level `locales.defaultPrefix` for this target.
   */
  defaultPrefix?: boolean
  /**
   * Override site-level `locales.detection` for this target.
   */
  detection?: boolean
  cache?: CacheConfig
  /**
   * Per-target history / revisions (undo, rollback). Default: enabled
   * with 50-revision retention. Set `{ enabled: false }` to disable
   * entirely (no `.gazetta/history/` writes on save/publish) for
   * targets where the storage cost isn't worth it (e.g., ephemeral CI
   * preview targets).
   */
  history?: HistoryConfig
  /**
   * Image-transform delivery strategy. When unset, `sharp` adapter is
   * used — bytes serve from origin with the immutable cache headers
   * the v1 slice ships. Set to `cloudflare` (or future adapters) to
   * route URLs through a CDN's transform pipeline.
   */
  transforms?: TransformConfig
  /**
   * Per-target asset upload policy. Today carries the size cap; future
   * fields (MIME allowlist subset, name policy overrides) extend this
   * block additively. Default cap when unset: 50 MB
   * (DEFAULT_ASSET_MAX_BYTES in assets/validate.ts).
   *
   * Example use cases:
   *   - Cloudflare Workers Free tier: cap below 100 MB worker body limit
   *   - Self-hosted with nginx + S3: raise to 500 MB for raw-photo
   *     workflows
   *   - Locked-down prod target: cap at the smallest sensible value
   *     for the site's content
   */
  assets?: AssetUploadConfig
}

/** Per-target asset upload policy. */
export interface AssetUploadConfig {
  /**
   * Per-asset upload size cap in bytes. Validates against the bytes
   * actually received (sniffed at ingest time, not the client's
   * Content-Length claim). Default: 50 MB.
   */
  maxBytes?: number
}

/** Per-target transform-adapter configuration. */
export interface TransformConfig {
  /**
   * Adapter name. v1 ships:
   *   - `sharp` (default): origin bytes + pre-generated variant ladder
   *   - `cloudflare`: `/cdn-cgi/image/...` URL builder against a zone
   */
  adapter: 'sharp' | 'cloudflare'
  /**
   * Cloudflare adapter only: the zone (hostname) where `/cdn-cgi/image/`
   * is served. Required when adapter is `cloudflare`.
   */
  zone?: string
}

/** Per-target history configuration. */
export interface HistoryConfig {
  /** Record revisions on save/publish. Default: true. */
  enabled?: boolean
  /**
   * Keep at most N most-recent revisions; oldest evicted on write.
   * Default: 50.
   */
  retention?: number
}

/** Determine rendering type for a target — centralised logic used by CLI and admin API */
export function getType(target: TargetConfig): TargetType {
  return target.type ?? (target.worker ? 'dynamic' : 'static')
}

/** Resolve a target's environment. Defaults to 'local' — production must be explicit. */
export function getEnvironment(target: TargetConfig): TargetEnvironment {
  return target.environment ?? 'local'
}

/**
 * Whether the author can save and receive publishes on this target from the CMS.
 * Default: true for `environment: local`, false for `staging` / `production`.
 */
export function isEditable(target: TargetConfig): boolean {
  return target.editable ?? getEnvironment(target) === 'local'
}

/** Default retention: keep the last 50 revisions. Matches design-publishing.md. */
export const DEFAULT_HISTORY_RETENTION = 50

/** Whether this target records history on save/publish. Default: true. */
export function isHistoryEnabled(target: TargetConfig): boolean {
  return target.history?.enabled ?? true
}

/**
 * Effective retention (max revisions) for this target. Defaults to
 * `DEFAULT_HISTORY_RETENTION`. Values ≤ 0 are clamped to 1 — retaining
 * zero revisions would mean every write evicts itself, which is
 * confusing; use `enabled: false` to disable entirely.
 */
export function getHistoryRetention(target: TargetConfig): number {
  const raw = target.history?.retention ?? DEFAULT_HISTORY_RETENTION
  return raw > 0 ? raw : 1
}

/**
 * i18n configuration. Opt-in: absent = single-locale site.
 * Adding `locales` enables multi-locale support.
 */
export interface LocalesConfig {
  /** All supported locale codes (BCP 47). First entry is the default if `locale` is not set. */
  supported: string[]
  /** Locale-specific fallback chains. E.g. `{ 'pt-BR': 'pt' }` → pt-BR falls back to pt before default. */
  fallbacks?: Record<string, string>
  /** Whether the default locale gets a URL prefix. Default: false (no prefix for default). */
  defaultPrefix?: boolean
  /** Enable Accept-Language detection and redirect. Default: false. */
  detection?: boolean
}

/**
 * Theme configuration. Opt-in: absent = single-theme site (no theme overrides
 * on assets). Themes are a peer override dimension to locales — assets can
 * declare locale-specific bytes, theme-specific bytes, or both.
 *
 * v1 enables themes on **assets only**. Page/fragment theme variants are
 * deferred; templates emit theme-aware CSS via PrimeVue tokens / class-based
 * cascade. See design-media.md and css-theming.md.
 */
export interface ThemesConfig {
  /** Supported theme names (lowercase ASCII, no dots). Conventionally `['light', 'dark']`. */
  supported: string[]
  /** Default theme name. Falls back to first in `supported`. */
  default?: string
}

/** Site manifest (site.yaml) */
export interface SiteManifest {
  name: string
  version?: string
  /** Default locale code (BCP 47). Falls back to first in `locales.supported`, then 'en'. */
  locale?: string
  /** i18n configuration. Absent = single-locale site. */
  locales?: LocalesConfig
  /**
   * Theme configuration for asset overrides. Absent = no theme dimension
   * (assets are theme-agnostic). When set, assets can carry per-theme
   * byte overrides, and the resolver picks variants per render context.
   */
  themes?: ThemesConfig
  /** Default Open Graph image for pages that don't specify their own. */
  defaultOgImage?: string
  systemPages?: string[]
  targets?: Record<string, TargetConfig>
}

/** Directory entry returned by StorageProvider.readDir */
export interface DirEntry {
  name: string
  isDirectory: boolean
}

/**
 * Byte range for `StorageProvider.readStream`.
 * Both `start` and `end` are inclusive (matches HTTP Range and Node `fs.createReadStream`).
 */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Storage abstraction — filesystem, S3, R2, Azure Blob.
 *
 * Implementations must provide atomic writes from a reader's perspective
 * (filesystem uses write-then-rename; cloud PUT is naturally atomic per
 * object; multipart uploads commit atomically). `readStream` must honor
 * the optional `range` argument for video/audio seek.
 *
 * Binary streaming is part of the base contract, not a separate
 * capability — every provider Gazetta ships supports it, and custom
 * providers must too. Authors writing a non-streaming custom provider
 * get a compile-time error (missing `readStream`/`writeStream`) rather
 * than a runtime capability check that surfaces at publish time.
 */
export interface StorageProvider {
  readFile(path: string): Promise<string>
  readDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
  rm(path: string): Promise<void>
  readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>
  writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void>
}

/** Resolved component ready for rendering */
export interface ResolvedComponent {
  template: TemplateFunction
  content?: Record<string, unknown>
  children: ResolvedComponent[]
  path?: string
  /** Component's position in the page tree (e.g., "hero", "@header/logo", "features/fast") */
  treePath?: string
}

/** Purge strategy for cache invalidation */
export interface PurgeStrategy {
  purgeAll(): Promise<void>
  purgeUrls(urls: string[]): Promise<void>
}
