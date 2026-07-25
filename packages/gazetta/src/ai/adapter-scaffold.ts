/**
 * Shared scaffolding for `AltTextAdapter` implementations.
 *
 * Per Phase 4 of the Path X migration: the three v1.5 providers (Anthropic,
 * OpenAI, Ollama) share substantial orchestration — operator-supplied
 * prompt prepending, max-tokens derivation, refusal-marker layering, error
 * translation. This module owns those shared concerns; per-provider files
 * contribute only the provider-specific call (`callProvider`), abort
 * detection (`isAbortError`), and refusal markers (`refusalMarkers`).
 *
 * # SOLID
 *
 *   - SRP: this module owns the alt-text adapter orchestration. Provider
 *     files own the SDK call + response parsing.
 *   - OCP: adding a fourth provider supplies a `callProvider` closure;
 *     no edits to scaffolding.
 *   - LSP: every adapter built via this scaffold honors the
 *     `AltTextAdapter` contract identically.
 *   - DIP: scaffold depends on `AltTextAdapter`, `AltGenerateInput`,
 *     `AltSuggestion` — abstractions, not provider SDK types.
 */
import { AIAdapterFailedError, AIError } from './errors.js'
import { detectRefusal } from './refusal.js'
import type { AltGenerateInput, AltSuggestion, AltTextAdapter } from '../alt/adapter.js'

/** Approximate characters-per-output-token for max-tokens derivation. */
const CHARS_PER_TOKEN = 4
/** Floor for derived max-tokens; ensures small maxChars still gives the model room. */
export const MIN_MAX_TOKENS = 64

/**
 * Provider-specific request closure passed to the scaffold. The closure
 * makes the actual SDK call and returns the response text.
 *
 * The scaffold supplies:
 *   - `bytes` / `mime` from prepared input
 *   - `systemPrompt` already prepended with operator override (if any)
 *   - `maxTokens` already resolved (operator override OR derived from maxChars)
 *   - `userPrompt` from the suggester's compose-prompt output (the
 *     base prompt minus operator's prepend; useful for OpenAI/Ollama
 *     which split system vs. user)
 *   - `request` original AltRequest for adapters that want maxChars / locale
 *   - `signal` AbortSignal forwarded from caller
 */
export interface ProviderCallInput {
  bytes: Uint8Array
  mime: string
  systemPrompt: string
  maxTokens: number
  request: AltGenerateInput['request']
  signal?: AbortSignal
}

export interface AdapterScaffoldOptions {
  /** Stable identifier for diagnostics ('anthropic', 'openai', 'ollama'). */
  name: string
  /** MIME types the underlying provider accepts. */
  supportedMimes: ReadonlySet<string>
  /** Operator-supplied system prompt; prepended to the system-composed prompt. */
  operatorSystemPrompt?: string
  /** Operator-supplied max tokens; overrides derivation from maxChars. */
  operatorMaxTokens?: number
  /** Provider-specific refusal markers; layered on top of shared markers. */
  refusalMarkers: readonly string[]
  /**
   * Provider SDK call. Returns response text on success; throws on
   * transport / API failure. Aborts should propagate as-is so the
   * suggester's `signal.aborted` check returns null.
   */
  callProvider(input: ProviderCallInput): Promise<string>
  /**
   * True for the SDK's user-abort exception type. Different SDKs throw
   * different abort types; the scaffold lets each provider declare
   * which one to pass through unchanged.
   */
  isAbortError(err: unknown): boolean
  /**
   * Optional human-readable context appended to error messages
   * (e.g., "Is Ollama running at http://localhost:11434?").
   */
  errorContextSuffix?: string
}

/**
 * Build an `AltTextAdapter` from provider-specific configuration. Owns
 * the orchestration so per-provider files contribute only the SDK call
 * and shape parsing.
 */
export function buildAltAdapterFromScaffold(opts: AdapterScaffoldOptions): AltTextAdapter {
  const operatorSystemPrompt = opts.operatorSystemPrompt
  const operatorMaxTokens = opts.operatorMaxTokens

  return {
    name: opts.name,
    supports(mime: string): boolean {
      return opts.supportedMimes.has(mime)
    },
    async generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion> {
      // max_tokens: operator override > derived from maxChars.
      const maxTokens =
        operatorMaxTokens ?? Math.max(MIN_MAX_TOKENS, Math.ceil(input.request.maxChars / CHARS_PER_TOKEN))

      // System prompt: operator-supplied prepends to the system-composed
      // prompt (per design-ai.md "Prompt composition"). Empty/absent
      // operator prompt → just the system-composed.
      const systemPrompt = operatorSystemPrompt ? `${operatorSystemPrompt}\n\n${input.prompt}` : input.prompt

      let text: string
      try {
        text = await opts.callProvider({
          bytes: input.bytes,
          mime: input.mime,
          systemPrompt,
          maxTokens,
          request: input.request,
          signal,
        })
      } catch (err) {
        // Aborts pass through — suggester checks `signal.aborted` and
        // returns null. Wrapping into AIAdapterFailedError would lose
        // the abort signal.
        if (opts.isAbortError(err)) throw err
        // AI-domain errors thrown by the provider's response-parsing
        // (e.g., AIInvalidResponseError when the SDK returns no text
        // block) pass through unchanged. Only transport / SDK-level
        // failures get wrapped as AIAdapterFailedError.
        if (err instanceof AIError) throw err
        const suffix = opts.errorContextSuffix ? `. ${opts.errorContextSuffix}` : ''
        if (err instanceof Error) {
          throw new AIAdapterFailedError(`${opts.name} alt-text generation failed: ${err.message}${suffix}`, {
            cause: err,
          })
        }
        throw new AIAdapterFailedError(`${opts.name} alt-text generation failed: unknown error${suffix}`)
      }

      const trimmed = text.trim()
      const refusal = detectRefusal(trimmed, opts.refusalMarkers)
      return {
        text: trimmed,
        refused: refusal.refused,
        refusalReason: refusal.reason,
      }
    },
  }
}
