/**
 * Public surface of `ai/` — cross-task AI infrastructure shared by
 * per-task implementations (alt-text in v1.5; translation, tag
 * suggestion, summarization in future).
 *
 * `ai/` is a code library, not an inheritance hierarchy. Tasks compose
 * these utilities — they don't extend a base class. Per
 * [team-preferences.md] convention 1: composition over inheritance.
 */

export type { AIProvider, ResolvedAIBase } from './provider.js'
export {
  AIError,
  AIAdapterUnavailableError,
  AIAdapterFailedError,
  AIInvalidResponseError,
  type AIErrorCode,
  type AIErrorHttpStatus,
  type AIErrorResponseBody,
} from './errors.js'
export { detectRefusal, type RefusalDetection } from './refusal.js'
export { composePrompt, type PromptPolicy } from './compose-prompt.js'
export { prepareForVision, MAX_EDGE, type PrepareInput, type PreparedImage } from './vision-prep.js'
