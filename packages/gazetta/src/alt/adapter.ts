/**
 * `AltTextAdapter` — provider-substitutable interface for generating
 * alt text from image bytes.
 *
 * Three concrete implementations ship in v1.5: `anthropicAltAdapter`,
 * `openAIAltAdapter`, `ollamaAltAdapter` (commits 3-5). One safe
 * default also ships: `nullAltAdapter` (this commit), used when no
 * adapter is configured for the target.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the alt-text task contracts (request,
 *     suggestion, adapter interface). Nothing else lives here.
 *   - OCP: new providers implement the interface and slot into the
 *     factory (commit 6). No existing module changes.
 *   - LSP: every adapter — including `nullAltAdapter` — honors the
 *     same contract. Substitutable in tests.
 *   - ISP: adapter exposes only `name`, `supports`, `generate` — no
 *     UI concerns, no config concerns.
 *   - DIP: callers depend on this interface, not on Anthropic SDK,
 *     OpenAI SDK, or Ollama HTTP details.
 *
 * # Why `AltSuggestion` carries refused state
 *
 * Vision providers can return a 200 OK with refusal text in the
 * content field (e.g., "I can't describe this image"). The structural
 * cut: refusal is a *successful API call with a domain-level no*.
 * Treating refusal as a structured field — not as inspecting `text`
 * for substrings in every consumer — keeps DIP. UI consumers branch
 * on `refused`, not on text patterns.
 *
 * Considered and rejected: a `confidence: number | null` field.
 * Vision providers don't expose calibrated confidence for free-form
 * description tasks; a hardcoded null would be a stub-on-the-interface
 * (LSP violation, per [team-preferences rule 18]). If a future
 * provider exposes real calibrated confidence, it lands as a separate
 * field — not as a retrofit of a placeholder.
 */
import type { PromptPolicy } from '../ai/compose-prompt.js'

/**
 * What the caller wants. Provider-agnostic. Each field has a documented
 * default applied by the factory when callers don't specify.
 */
export interface AltRequest {
  /**
   * Target language for the description (BCP 47 locale code; 'en',
   * 'fr', 'pt-BR'). The model writes alt directly in this language —
   * no separate translation pass. Default 'en'.
   */
  locale: string
  /**
   * Soft length suggestion in characters. Used in prompt guidance
   * ("Maximum N characters") and as native `max_tokens` derivation
   * for adapters that have it. Default 125 (WAI-ARIA convention).
   *
   * NOT enforced by the suggester or adapter — if the model returns
   * longer text, the consumer sees the full string and can edit. Hard
   * truncation would lose meaning.
   */
  maxChars: number
  /**
   * Output style. Closed enum; extended additively (future:
   * `'marketing' | 'technical'`).
   */
  style: AltStyle
}

/** Closed enum; extends additively. */
export type AltStyle = 'descriptive'

/** Default `AltRequest` values, applied by the suggester when callers omit fields. */
export const DEFAULT_ALT_REQUEST: AltRequest = {
  locale: 'en',
  maxChars: 125,
  style: 'descriptive',
}

/**
 * What the suggester delivers. `text` is the model's output (which may
 * be a refusal). `refused` is the structured signal: when true, don't
 * auto-fill, surface `refusalReason` to the author instead.
 */
export interface AltSuggestion {
  text: string
  /** True when the model declined or couldn't describe the image. */
  refused: boolean
  /** Truncated reason text when refused; null otherwise. */
  refusalReason: string | null
}

/**
 * Input to an adapter's `generate` call. The suggester does prep:
 *
 *   - Resolves `AltRequest` from caller-provided fields + defaults
 *   - Composes the prompt via `composePrompt(request, policies)`
 *   - Calls `prepareForVision` on the bytes
 *
 * The adapter receives both the structured request (for native params
 * like Anthropic's `max_tokens`) and the composed prompt string (for
 * adapters that just inject text). Pre-computed once per call.
 */
export interface AltGenerateInput {
  /** Bytes ready to send to the provider (post-prep, ≤ maxImageEdge). */
  bytes: Uint8Array
  /** MIME of the prepared bytes — `image/jpeg` or `image/png`. */
  mime: string
  /** Structured request — adapters with native parameters use this. */
  request: AltRequest
  /** Composed prompt string — adapters that just need a prompt use this. */
  prompt: string
}

/**
 * Per-task adapter contract. Every implementation honors this exactly;
 * substitutable across tests and production via the factory.
 *
 * Throws on transport / provider errors (`AIAdapterFailedError` from
 * `ai/errors.ts`). Refusals are NOT thrown — they're returned in the
 * structured `AltSuggestion`. The distinction: throws are runtime
 * failures (retryable; gateway-level concern); refusals are domain
 * outcomes (not retryable; user-level concern).
 */
export interface AltTextAdapter {
  /** Stable identifier for diagnostics ('anthropic', 'openai', 'ollama', 'null'). */
  readonly name: string

  /**
   * True when this adapter can describe the given MIME. v1.5 adapters
   * support image MIMEs only. The null adapter returns false for
   * everything.
   */
  supports(mime: string): boolean

  /**
   * Generate alt text. Forwards `signal` to the underlying provider
   * call so consumers can cancel in-flight requests (e.g., when the
   * author starts typing into the alt field).
   *
   * Throws `AIAdapterFailedError` / `AIInvalidResponseError` on
   * transport or response-shape failures. Returns refusals as
   * `AltSuggestion` with `refused: true`.
   */
  generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion>
}

/**
 * Type alias for prompt policies operating on alt-text requests.
 * Per-task policy modules implement these and pass arrays to the
 * generic `composePrompt<AltRequest>(req, policies)`.
 */
export type AltPromptPolicy = PromptPolicy<AltRequest>
