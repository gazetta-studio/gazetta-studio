/**
 * Public surface of `alt/` — alt-text task. Per [design-ai.md], `alt/`
 * is one of several per-task directories that compose `ai/` shared
 * infrastructure (refusal detection, prompt composition, vision
 * preprocessing).
 *
 * v1.5 ships:
 *   - the `AltTextAdapter` interface + supporting types
 *   - default policy set + composable prompt policies
 *   - `nullAltAdapter` (safe default when no adapter is configured)
 *   - `createAltSuggester` (orchestration)
 *
 * v1.5 commits 3-5 add the three real adapters (Anthropic, OpenAI,
 * Ollama). Commit 6 adds the factory wiring config to adapter.
 */

export type {
  AltGenerateInput,
  AltPromptPolicy,
  AltRequest,
  AltStyle,
  AltSuggestion,
  AltTextAdapter,
} from './adapter.js'
export { DEFAULT_ALT_REQUEST } from './adapter.js'
export { nullAltAdapter } from './null-adapter.js'
export {
  DEFAULT_ALT_PROMPT_POLICIES,
  lengthPolicy,
  localePolicy,
  outputDisciplinePolicy,
  styleGuidancePolicy,
  taskFramingPolicy,
} from './prompt-policies.js'
export {
  type AltSuggester,
  type CreateAltSuggesterOptions,
  type SuggestInput,
  createAltSuggester,
} from './suggester.js'
