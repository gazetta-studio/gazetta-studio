/**
 * OpenAI adapter — alt-text via the `chat.completions.create` vision API.
 *
 * # Defaults
 *
 *   - Model: `gpt-4o-mini` — vision-capable, well-supported. Note that
 *     OpenAI's vision pricing is non-trivial: while gpt-4o-mini is
 *     cheaper per text token than gpt-4o, vision token cost differs
 *     and the math is workload-dependent. Sites comparing costs
 *     should benchmark against their actual asset library; sites that
 *     want explicit cost-ceiling pick a specific model in `site.config.ts`.
 *
 * # API contract details (verified against `openai` SDK v6+)
 *
 *   - Image content uses `{ type: 'image_url', image_url: { url } }`.
 *     The URL is a base64 data URL: `data:{mime};base64,{data}`.
 *   - Accepted MIMEs: JPEG, PNG, GIF, WebP. After `prepareForVision`
 *     our bytes are JPEG or PNG.
 *   - System prompt is a `role: 'system'` message (not a top-level
 *     parameter like Anthropic). The user message contains the image.
 *   - `max_tokens` is optional but we set it derived from
 *     `request.maxChars` for predictable cost. Floor at 64.
 *
 * # AbortSignal
 *
 *   - Passed via `chat.completions.create(body, { signal })`. SDK
 *     throws `APIUserAbortError` on abort; adapter rethrows so the
 *     suggester's `signal.aborted` check can return null.
 *
 * # Errors
 *
 *   - SDK throws typed subclasses identical in shape to Anthropic's
 *     SDK: `APIUserAbortError`, `RateLimitError`, `AuthenticationError`,
 *     `BadRequestError`, etc. Adapter translates non-abort errors to
 *     `AIAdapterFailedError` with the SDK error as `cause`.
 *
 * # SOLID
 *
 *   - Same SOLID lenses as Anthropic adapter (commit 3): SRP, LSP, DIP.
 *     The adapter abstraction holds across both providers — same
 *     contract, different request/response/error shapes encapsulated
 *     here.
 */
import OpenAI from 'openai'
import { AIAdapterFailedError, AIInvalidResponseError } from '../ai/errors.js'
import { detectRefusal } from '../ai/refusal.js'
import type { AltGenerateInput, AltSuggestion, AltTextAdapter } from './adapter.js'

/**
 * OpenAI-specific refusal phrases. Layered on top of the shared list
 * in `ai/refusal.ts`. Kept here so provider-specific drift evolves
 * independently.
 */
const OPENAI_REFUSAL_MARKERS: readonly string[] = [
  "i'm sorry, i can't assist",
  "i can't assist with that",
  'i am unable to assist',
]

/**
 * Default model. Vision-capable across OpenAI's gpt-4o family. Sites
 * with high-volume asset libraries should benchmark cost against
 * actual workload — gpt-4o-mini's vision token use isn't strictly
 * cheaper than gpt-4o despite the lower text-token rate.
 */
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini'

const CHARS_PER_TOKEN = 4
const MIN_MAX_TOKENS = 64

const OPENAI_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export interface OpenAIAltAdapterOptions {
  apiKey: string
  /** Model ID; defaults to {@link OPENAI_DEFAULT_MODEL}. */
  model?: string
  /** Optional override of the SDK base URL — for tests pointing at msw or proxy setups. */
  baseURL?: string
  /**
   * Override the SDK's retry count (default 2). Tests pass 0 to keep
   * runs deterministic and fast.
   */
  maxRetries?: number
}

function toBase64DataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Construct the OpenAI alt-text adapter. Pure factory; caller supplies
 * literal `apiKey`. Factory wiring (commit 6) reads env vars; this
 * adapter doesn't.
 */
export function createOpenAIAltAdapter(opts: OpenAIAltAdapterOptions): AltTextAdapter {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: opts.maxRetries,
  })
  const model = opts.model ?? OPENAI_DEFAULT_MODEL

  return {
    name: 'openai',
    supports(mime: string) {
      return OPENAI_SUPPORTED_MIMES.has(mime)
    },
    async generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion> {
      const maxTokens = Math.max(MIN_MAX_TOKENS, Math.ceil(input.request.maxChars / CHARS_PER_TOKEN))

      let response: OpenAI.Chat.Completions.ChatCompletion
      try {
        response = await client.chat.completions.create(
          {
            model,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: input.prompt },
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: { url: toBase64DataUrl(input.bytes, input.mime) },
                  },
                ],
              },
            ],
          },
          { signal },
        )
      } catch (err) {
        // Aborts pass through; suggester translates to null.
        if (err instanceof OpenAI.APIUserAbortError) throw err
        if (err instanceof Error) {
          throw new AIAdapterFailedError(`OpenAI alt-text generation failed: ${err.message}`, { cause: err })
        }
        throw new AIAdapterFailedError('OpenAI alt-text generation failed: unknown error')
      }

      // Response shape: choices[0].message.content. May be null when
      // the model returns a tool-call instead — defensive against that.
      const content = response.choices[0]?.message.content
      if (typeof content !== 'string') {
        throw new AIInvalidResponseError('OpenAI response had no text content')
      }

      const text = content.trim()
      const refusal = detectRefusal(text, OPENAI_REFUSAL_MARKERS)
      return {
        text,
        refused: refusal.refused,
        refusalReason: refusal.reason,
      }
    },
  }
}
