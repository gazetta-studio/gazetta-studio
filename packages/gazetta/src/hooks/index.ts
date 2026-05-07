/**
 * Hooks barrel. Cut 1 ships the type-only foundation; subsequent
 * cuts add the registry (Cut 2), discovery (Cut 3), wired
 * lifecycle phases (Cuts 4-6), audit integration (Cut 7), review
 * phases (Cut 8), and the plugin-registration shim (Cut 9).
 */
export type {
  HookPhase,
  HookScope,
  HookContext,
  HookLogger,
  ReadOnlySiteConfig,
  HookHandler,
  HookOptions,
  HookRegistration,
  BeforeSaveHook,
  AfterSaveHook,
  AfterLoadHook,
  SaveResult,
  BeforePublishHook,
  AfterPublishHook,
  PublishItem,
  PublishHookResult,
  BeforeUploadHook,
  AfterUploadHook,
  UploadHookAsset,
  UploadHookPayload,
  UploadHookResult,
} from './types.js'
export type { ReadOnlyStorageProvider } from './storage.js'
export { HookError, HookCancellation, HookTimeout, RegistrationAfterInitError } from './errors.js'
export { HookRegistry } from './registry.js'
export {
  dispatchBeforeSave,
  dispatchAfterSave,
  dispatchAfterLoad,
  dispatchBeforePublish,
  dispatchAfterPublish,
  dispatchBeforeUpload,
  dispatchAfterUpload,
} from './dispatch.js'
export { discoverSiteLocalHooks, type DiscoverOptions, type DiscoveryResult, type HookFileMeta } from './discovery.js'
export { buildHookContext, type BuildHookContextOptions } from './context.js'
export {
  eventFromRegistration,
  type HookFiringEmitter,
  type HookFiringEvent,
} from './audit-emitter.js'
