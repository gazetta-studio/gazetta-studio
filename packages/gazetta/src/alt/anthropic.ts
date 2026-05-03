/**
 * Anthropic Claude adapter — alt-text via the `messages.create` vision API.
 *
 * # Defaults
 *
 *   - Model: `claude-haiku-4-5` (cost-effective vision; ~$0.003/image).
 *     Sites needing higher quality override via `altText.model` in `site.yaml`.
 *
 * # API contract details (verified against @anthropic-ai/sdk v0.92.0)
 *
 *   - Image content: `{ type: 'image', source: { type: 'base64',
 *     media_type, data: <base64-string> } }`. SDK requires base64-encoded
 *     string, not raw bytes/Uint8Array.
 *   - Accepted MIME types: `image/jpeg`, `image/png`, `image/gif`,
 *     `image/webp`. After `prepareForVision`, our bytes are always JPEG
 *     or PNG, both supported.
 *   - `max_tokens` is required by the API. We derive it from
 *     `request.maxChars` (≈4 chars/token; floor at 64 to give the model
 *     headroom for short descriptions).
 *   - `system` parameter at the top level (not a message role). The
 *     composed prompt is the system prompt; the user message holds the
 *     image.
 *
 * # AbortSignal
 *
 *   - Passed via `messages.create(body, { signal })`. SDK throws
 *     `APIUserAbortError` on abort; we let the suggester layer translate
 *     that to `null` via its abort-detection logic.
 *
 * # Errors
 *
 *   - SDK throws typed subclasses: `RateLimitError`,
 *     `AuthenticationError`, `BadRequestError`,
 *     `APIConnectionError`/`APIConnectionTimeoutError`,
 *     `InternalServerError`, etc.
 *   - We translate to our own `AIAdapterFailedError` so the suggester
 *     contract stays provider-agnostic. The original SDK error attaches
 *     as `cause` for log/debug visibility.
 *
 * # SOLID
 *
 *   - SRP: this module owns Anthropic-specific request shape, response
 *     parsing, and error translation. Nothing else.
 *   - LSP: implements `AltTextAdapter` exactly — substitutable.
 *   - DIP: callers/factory depend on `createAnthropicAltAdapter` returning
 *     `AltTextAdapter`; never on `Anthropic` SDK type directly.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AIAdapterFailedError, AIInvalidResponseError } from '../ai/errors.js'
import { detectRefusal } from '../ai/refusal.js'
import type { AltGenerateInput, AltSuggestion, AltTextAdapter } from './adapter.js'

/**
 * Anthropic-specific refusal phrases observed in production responses
 * but not yet in `ai/refusal.ts`'s shared list. Maintained here so
 * provider-specific markers evolve independently of the shared list.
 */
const ANTHROPIC_REFUSAL_MARKERS: readonly string[] = ['i cannot create captions', 'i cannot generate descriptions']

/**
 * Default model for the Anthropic adapter. Haiku is the cost-optimized
 * choice for the alt-text task (~$0.003/image at 768x768 input). Sites
 * needing higher quality set `altText.model` in `site.yaml` to a Sonnet
 * or Opus model.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5'

/**
 * Approximate characters-per-token for output sizing. Short, factual
 * descriptions skew slightly higher than this (≈3.5 chars/token in
 * English) but the safety margin is fine. Floor of 64 ensures the model
 * has room even for the smallest configured maxChars.
 */
const CHARS_PER_TOKEN = 4
const MIN_MAX_TOKENS = 64

export interface AnthropicAltAdapterOptions {
  apiKey: string
  /** Model ID; defaults to {@link ANTHROPIC_DEFAULT_MODEL}. */
  model?: string
  /**
   * Optional override of the SDK base URL — handy for tests pointing
   * at msw, or future operators routing through a private proxy.
   */
  baseURL?: string
  /**
   * Override the SDK's retry count (default 2). Tests pass 0 to keep
   * runs deterministic and fast; production sticks with the default
   * so transient 429/5xx are auto-retried with backoff.
   */
  maxRetries?: number
}

/** Encode a Uint8Array as a base64 string for the API call. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Anthropic only accepts a subset of image MIME types. After
 * `prepareForVision` our bytes are JPEG or PNG, but defending here
 * means a future caller invoking the adapter directly with WebP or
 * GIF still gets the right answer.
 */
const ANTHROPIC_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * Construct the Anthropic alt-text adapter. Pure factory — caller
 * supplies a literal `apiKey`. The factory in `alt/index.ts` (commit 6)
 * reads env vars and constructs us; tests pass literal keys. No
 * `process.env` reads inside the adapter.
 */
export function createAnthropicAltAdapter(opts: AnthropicAltAdapterOptions): AltTextAdapter {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: opts.maxRetries,
  })
  const model = opts.model ?? ANTHROPIC_DEFAULT_MODEL

  return {
    name: 'anthropic',
    supports(mime: string) {
      return ANTHROPIC_SUPPORTED_MIMES.has(mime)
    },
    async generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion> {
      // Derive max_tokens from the request's character budget. Floor so
      // very small maxChars still gives the model space to respond.
      const maxTokens = Math.max(MIN_MAX_TOKENS, Math.ceil(input.request.maxChars / CHARS_PER_TOKEN))

      let response: Anthropic.Message
      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: input.prompt,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      // SDK accepts the four MIMEs above; cast is safe
                      // because supports() guards entry.
                      media_type: input.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                      data: toBase64(input.bytes),
                    },
                  },
                ],
              },
            ],
          },
          { signal },
        )
      } catch (err) {
        // Let aborts propagate as-is — the suggester checks
        // `signal.aborted` and returns null. Wrapping into an
        // AIAdapterFailedError would lose the abort signal.
        if (err instanceof Anthropic.APIUserAbortError) throw err
        // Translate every other SDK error into our domain error,
        // preserving cause for diagnostics.
        if (err instanceof Error) {
          throw new AIAdapterFailedError(`Anthropic alt-text generation failed: ${err.message}`, { cause: err })
        }
        throw new AIAdapterFailedError('Anthropic alt-text generation failed: unknown error')
      }

      // Response shape: `content` is an array of blocks; alt-text comes
      // back as a single text block. Defensive against tool-use blocks
      // or unexpected shapes by finding the first text block.
      const textBlock = response.content.find(block => block.type === 'text')
      if (!textBlock || textBlock.type !== 'text') {
        throw new AIInvalidResponseError('Anthropic response contained no text content block')
      }

      const text = textBlock.text.trim()
      const refusal = detectRefusal(text, ANTHROPIC_REFUSAL_MARKERS)
      return {
        text,
        refused: refusal.refused,
        refusalReason: refusal.reason,
      }
    },
  }
}
