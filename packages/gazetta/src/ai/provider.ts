/**
 * `AIProvider` — transport-only interface for an AI account / endpoint.
 *
 * Per [`design-ai.md`](../../../.claude/rules/design-ai.md) "Two-axis split":
 * the provider holds transport (apiKey, baseUrl, organizationId, timeout)
 * and exposes per-task builder methods that return per-task adapters.
 * Operational config (model, systemPrompt, maxTokens) lives in
 * data-literal blocks the resolver feeds to `provider.altText({...})`
 * at boot — not on the provider constructor.
 *
 * Why split: one Anthropic account legitimately serves multiple tasks
 * (alt-text, future translation, future summarization, future
 * image-gen) with different model + prompt + token-budget per task.
 * Putting model/prompt on the constructor would force operators to
 * build a separate provider per task; transport-only keeps providers
 * reusable across tasks.
 *
 * Future tasks add their own builder method here:
 *   - `translation(taskConfig: TranslationTaskConfig): TranslationAdapter`
 *   - `summarization(taskConfig: SummarizationTaskConfig): SummarizationAdapter`
 *
 * Plugin-supplied providers may extend this with their own builder
 * methods; consumers depend on the abstraction (`AIProvider`), not
 * the concrete provider classes.
 */
import type { AltTextAdapter } from '../alt/adapter.js'

/**
 * Per-task configuration for the alt-text task. Data-literal type fed to
 * `provider.altText(taskConfig)` by the resolver. Field details:
 *
 *   - `model` — non-optional at adapter construction; the resolver always
 *     supplies one (chain falls through to `PROVIDER_DEFAULT_MODELS`).
 *     Operator-facing config blocks make it optional and inherit per the
 *     three-rung chain (target → site → gazetta → provider default).
 *
 *   - `systemPrompt` — operator-supplied voice/style override. When set,
 *     the suggester prepends it to the system-composed neutral prompt
 *     (see `design-ai.md` "Prompt composition"). Null/undefined = use
 *     system default only. Custom prompt policies (full replacement of
 *     the WCAG-grounded base) remain v1.6+ deferred.
 *
 *   - `maxTokens` — generation budget cap. Provider-specific default
 *     applies when null/undefined (Anthropic derives from `maxChars`;
 *     OpenAI/Ollama use SDK defaults).
 */
export interface AltTextTaskConfig {
  /** Model ID. Non-optional at adapter construction (resolver always supplies). */
  model: string
  /** Operator-supplied system prompt; prepended to the system-composed prompt. */
  systemPrompt?: string
  /** Generation token cap; provider-default applies when absent. */
  maxTokens?: number
}

/**
 * Transport-only AI provider. Constructor takes credentials/endpoint
 * config; builder methods construct per-task adapters from data-literal
 * task config.
 */
export interface AIProvider {
  /** Stable identifier for diagnostics + per-provider default-model lookup. */
  readonly name: string

  /**
   * Construct an alt-text adapter from per-task config. Resolver supplies
   * the merged `AltTextTaskConfig` from the three-rung inheritance chain.
   */
  altText(taskConfig: AltTextTaskConfig): AltTextAdapter

  // Future tasks:
  // translation(taskConfig: TranslationTaskConfig): TranslationAdapter
  // summarization(taskConfig: SummarizationTaskConfig): SummarizationAdapter
}

/**
 * Per-provider sensible default model. Used when the model field is
 * unset across the entire chain (gazetta → site → target). Plugin
 * providers contribute their own name; default-model fallback for
 * unknown plugin names returns undefined (operator must specify
 * `model` somewhere in the chain).
 */
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.2-vision:11b',
}
