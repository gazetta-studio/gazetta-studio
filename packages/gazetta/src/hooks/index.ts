/**
 * Hooks barrel. Cut 1 ships the type-only foundation; subsequent
 * cuts add the registry (Cut 2), wired lifecycle phases (Cuts 4-6),
 * audit integration (Cut 7), review phases (Cut 8), and the
 * factory-contribution registration path (Cut 9).
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
  ReviewTransition,
  BeforeReviewTransitionHook,
  AfterReviewTransitionHook,
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
export type { HookContribution, HookEntry } from './contribution.js'
export { buildHookContext, type BuildHookContextOptions } from './context.js'
export type { HookFiringEmitter, HookFiringEvent } from './audit-emitter.js'
