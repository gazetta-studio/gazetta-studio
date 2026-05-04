// Types (public API)
export type {
  RenderOutput,
  TemplateFunction,
  EditorMount,
  FieldMount,
  TemplateModule,
  ComponentManifest,
  FragmentManifest,
  PageManifest,
  SiteManifest,
  ResolvedComponent,
  TargetConfig,
  StorageConfig,
  WorkerConfig,
  CacheConfig,
  DirEntry,
  StorageProvider,
  ByteRange,
  PurgeStrategy,
} from './types.js'
export { getType, isEditable } from './types.js'
export type { TargetType } from './types.js'
export {
  createTargetRegistryView,
  listEditableTargets,
  UnknownTargetError,
  NoEditableTargetError,
} from './targets.js'
export type { TargetRegistry } from './targets.js'
export { createContentRoot } from './content-root.js'
export type { ContentRoot } from './content-root.js'
export { createSourceContext, createSourceContextFromRegistry } from './admin-api/source-context.js'
export type { SourceContext } from './admin-api/source-context.js'
export type {
  HistoryProvider,
  Revision,
  RevisionInput,
  RevisionManifest,
  RevisionOperation,
  HistoryRetention,
} from './history.js'
export { createHistoryProvider } from './history-provider.js'
export type { CreateHistoryProviderOptions } from './history-provider.js'
export {
  recordWrite,
  DEFAULT_SCAN_LOCATIONS,
  DEFAULT_SCAN_ROOT_FILES,
} from './history-recorder.js'
export type {
  RecordWriteOptions,
  WrittenItem,
  ScanLocation,
} from './history-recorder.js'
export { restoreRevision } from './history-restorer.js'
export type { RestoreRevisionOptions } from './history-restorer.js'
export {
  isHistoryEnabled,
  getHistoryRetention,
  DEFAULT_HISTORY_RETENTION,
} from './types.js'
export type { HistoryConfig, LocalesConfig, PageMetadata } from './types.js'

// Locale resolution
export {
  isValidLocale,
  normalizeLocale,
  defaultLocaleFor,
  resolveSiteLocales,
  resolveTargetLocales,
  localeFromFilename,
  localeFilename,
  resolveLocaleFallback,
  localeRoutePrefix,
} from './locale.js'
export type { ResolvedLocales } from './locale.js'

// Renderer
export {
  renderComponent,
  renderFragment,
  renderPage,
  type RenderPageOptions,
  type SeoContext,
} from './renderer.js'
export { resolveSeoTags, type ResolveSeoTagsInput } from './seo.js'
export { resolveComponent, resolveFragment, resolvePage } from './resolver.js'
export { loadSite } from './site-loader.js'
export type { Site, LocalizedEntry, PageEntry, FragmentEntry, LoadSiteOptions } from './site-loader.js'
export { allPageEntries, allFragmentEntries } from './site-loader.js'
export { loadTemplate, invalidateTemplate, invalidateAllTemplates } from './template-loader.js'
export { scopeHtml, scopeCss, hashPath } from './scope.js'

// Storage providers
export { createFilesystemProvider } from './providers/filesystem.js'
export { createAzureBlobProvider } from './providers/azure-blob.js'
export type { AzureBlobProviderOptions } from './providers/azure-blob.js'
export { createS3Provider } from './providers/s3.js'
export type { S3ProviderOptions } from './providers/s3.js'

// Targets
export { createStorageProvider, createTargetRegistry } from './targets.js'

// Bootstrap helpers — read site.yaml, build registry, derive SourceContext
export { bootstrapFromSiteYaml, buildSourceContext } from './cli/bootstrap.js'
export type { BootstrapResult, BuildSourceContextOptions } from './cli/bootstrap.js'

// Server
export { createServer } from './serve.js'
export type { ServeOptions } from './serve.js'

// Publish
export { publishItems, resolveDependencies } from './publish.js'
export {
  publishPageRendered,
  publishPageStatic,
  publishFragmentRendered,
  publishSiteManifest,
  publishDepIndices,
} from './publish-rendered.js'

// Format helpers
export { format } from './formats.js'

// ESI assembly (for edge workers and servers)
export { assembleEsi, parseCacheComment, splitFragment, findEsiPaths } from './assemble.js'

// Site config — typed identity functions for site.config.ts and gazetta.config.ts
export { defineSite, defineGazetta } from './config/index.js'
export type { SiteConfig, GazettaConfig } from './config/index.js'
export {
  ConfigError,
  ConfigValidationError,
  ConfigEvaluationError,
  ConfigLayoutError,
} from './config/index.js'

// Editor — import from 'gazetta/editor' (separate entry point to avoid pulling Tiptap into server builds)
