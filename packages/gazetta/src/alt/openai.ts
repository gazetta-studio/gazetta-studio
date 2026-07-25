/**
 * OpenAI adapter — alt-text via the `chat.completions.create` vision API.
 *
 * # Defaults
 *
 *   - Model: `gpt-4o-mini` — vision-capable, well-supported. Note that
 *     OpenAI's vision pricing is non-trivial: while gpt-4o-mini is
 *     cheaper per text token than gpt-4o, vision token cost differs
 *     and the math is workload-dependent. Sites comparing costs
 *     should benchmark against their actual asset library.
 *
 * # API contract details (verified against `openai` SDK v6+)
 *
 *   - Image content uses `{ type: 'image_url', image_url: { url } }`.
 *     The URL is a base64 data URL: `data:{mime};base64,{data}`.
 *   - Accepted MIMEs: JPEG, PNG, GIF, WebP. After `prepareForVision`
 *     our bytes are JPEG or PNG.
 *   - System prompt is a `role: 'system'` message (not a top-level
 *     parameter like Anthropic). User message contains the image.
 *   - `max_tokens` is optional but the scaffold sets it (operator
 *     override OR derived from maxChars).
 *
 * # AbortSignal
 *
 *   - Passed via `chat.completions.create(body, { signal })`. SDK throws
 *     `APIUserAbortError` on abort; scaffold's `isAbortError` recognizes
 *     it so the suggester can return null on cancellation.
 *
 * # SOLID
 *
 *   - Same lenses as Anthropic adapter — orchestration via
 *     `ai/adapter-scaffold.ts`, OpenAI-specific request/response
 *     shape here only.
 */
import OpenAI from 'openai'
import { AIInvalidResponseError } from '../ai/errors.js'
import type { AIProvider, AltTextTaskConfig } from '../ai/provider.js'
import { buildAltAdapterFromScaffold } from '../ai/adapter-scaffold.js'
import type { AltTextAdapter } from './adapter.js'

/**
 * OpenAI-specific refusal phrases. Layered on top of the shared list
 * in `ai/refusal.ts`.
 */
const OPENAI_REFUSAL_MARKERS: readonly string[] = [
  "i'm sorry, i can't assist",
  "i can't assist with that",
  'i am unable to assist',
]

/**
 * Default model. Vision-capable across OpenAI's gpt-4o family. Sites
 * with high-volume asset libraries should benchmark cost against
 * actual workload.
 */
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini'

const OPENAI_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * OpenAI transport-only options. Per Path X (transport-vs-task split).
 */
export interface OpenAITransportOptions {
  apiKey: string
  /** Optional override of the SDK base URL — for tests pointing at msw or proxy setups. */
  baseURL?: string
  /**
   * Override the SDK's retry count (default 2). Tests pass 0 to keep
   * runs deterministic and fast.
   */
  maxRetries?: number
}

/**
 * Internal type for `createOpenAIAltAdapter` callers (tests). Combines
 * transport with per-task config; new code goes through
 * `openaiProvider(transport).altText(taskConfig)`.
 */
export interface OpenAIAltAdapterOptions extends OpenAITransportOptions {
  /** Model ID; defaults to {@link OPENAI_DEFAULT_MODEL}. */
  model?: string
  /** Operator-supplied system prompt; prepended to system-composed prompt. */
  systemPrompt?: string
  /** Generation token cap; provider derives from maxChars when absent. */
  maxTokens?: number
}

function toBase64DataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Construct the OpenAI alt-text adapter. Internal factory — kept public
 * for tests + advanced wiring. Operator-facing config goes through
 * `openaiProvider(transport).altText(taskConfig)` (Path X).
 */
export function createOpenAIAltAdapter(opts: OpenAIAltAdapterOptions): AltTextAdapter {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: opts.maxRetries,
  })
  const model = opts.model ?? OPENAI_DEFAULT_MODEL

  return buildAltAdapterFromScaffold({
    name: 'openai',
    supportedMimes: OPENAI_SUPPORTED_MIMES,
    operatorSystemPrompt: opts.systemPrompt,
    operatorMaxTokens: opts.maxTokens,
    refusalMarkers: OPENAI_REFUSAL_MARKERS,
    isAbortError: err => err instanceof OpenAI.APIUserAbortError,
    async callProvider({ bytes, mime, systemPrompt, maxTokens, signal }) {
      const response = await client.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: toBase64DataUrl(bytes, mime) } }],
            },
          ],
        },
        { signal },
      )

      // Response shape: choices[0].message.content. May be null when
      // the model returns a tool-call instead — defensive against that.
      const content = response.choices[0]?.message.content
      if (typeof content !== 'string') {
        throw new AIInvalidResponseError('OpenAI response had no text content')
      }
      return content
    },
  })
}

/**
 * Operator-facing OpenAI provider. See `anthropicProvider` for the full
 * Path X rationale.
 */
export function openaiProvider(transport: OpenAITransportOptions): AIProvider {
  if (!transport.apiKey) {
    throw new Error('openaiProvider: "apiKey" is required (typically `process.env.OPENAI_API_KEY!`)')
  }
  return {
    name: 'openai',
    altText(taskConfig: AltTextTaskConfig): AltTextAdapter {
      return createOpenAIAltAdapter({
        ...transport,
        model: taskConfig.model,
        systemPrompt: taskConfig.systemPrompt,
        maxTokens: taskConfig.maxTokens,
      })
    },
  }
}
