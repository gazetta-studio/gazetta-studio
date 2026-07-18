/**
 * Anthropic Claude adapter — alt-text via the `messages.create` vision API.
 *
 * # Defaults
 *
 *   - Model: `claude-haiku-4-5` (cost-effective vision; ~$0.003/image).
 *     Sites needing higher quality override via `altText.model` in `site.config.ts`.
 *
 * # API contract details (verified against @anthropic-ai/sdk v0.92.0)
 *
 *   - Image content: `{ type: 'image', source: { type: 'base64',
 *     media_type, data: <base64-string> } }`. SDK requires base64-encoded
 *     string, not raw bytes/Uint8Array.
 *   - Accepted MIME types: `image/jpeg`, `image/png`, `image/gif`,
 *     `image/webp`. After `prepareForVision`, our bytes are always JPEG
 *     or PNG, both supported.
 *   - `max_tokens` is required by the API. Scaffold derives it from
 *     `request.maxChars` unless operator overrides via `maxTokens`.
 *   - `system` parameter at the top level (not a message role). The
 *     scaffold-prepared `systemPrompt` (operator override + composed)
 *     becomes the system prompt; the user message holds the image.
 *
 * # AbortSignal
 *
 *   - Passed via `messages.create(body, { signal })`. SDK throws
 *     `APIUserAbortError` on abort; scaffold's `isAbortError` recognizes
 *     it so the suggester can return null on cancellation.
 *
 * # SOLID
 *
 *   - SRP: this module owns the Anthropic-specific request shape and
 *     response parsing only. Orchestration (prompt-prepend, max-tokens
 *     derivation, error translation, refusal detection) lives in
 *     `ai/adapter-scaffold.ts`.
 *   - LSP: implements `AltTextAdapter` exactly via the scaffold —
 *     substitutable.
 *   - DIP: callers depend on `AltTextAdapter`; never on `Anthropic` SDK
 *     type directly.
 */
import Anthropic from '@anthropic-ai/sdk'
import { AIInvalidResponseError } from '../ai/errors.js'
import type { AIProvider, AltTextTaskConfig } from '../ai/provider.js'
import { buildAltAdapterFromScaffold } from '../ai/adapter-scaffold.js'
import type { AltTextAdapter } from './adapter.js'

/**
 * Anthropic-specific refusal phrases observed in production responses
 * but not yet in `ai/refusal.ts`'s shared list. Maintained here so
 * provider-specific markers evolve independently of the shared list.
 */
const ANTHROPIC_REFUSAL_MARKERS: readonly string[] = ['i cannot create captions', 'i cannot generate descriptions']

/**
 * Default model for the Anthropic adapter. Haiku is the cost-optimized
 * choice for the alt-text task (~$0.003/image at 768x768 input). Sites
 * needing higher quality set `altText.model` in `site.config.ts` to a
 * Sonnet or Opus model.
 */
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5'

/**
 * Anthropic only accepts a subset of image MIME types. After
 * `prepareForVision` our bytes are JPEG or PNG, but defending here
 * means a future caller invoking the adapter directly with WebP or
 * GIF still gets the right answer.
 */
const ANTHROPIC_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * Anthropic transport-only options. Per Path X (single-axis with
 * transport-vs-task split for AI), these fields bind to "which Anthropic
 * account at which endpoint" — not to per-task tuning. Per-task config
 * (model, systemPrompt, maxTokens) lives on the resolver-supplied
 * `AltTextTaskConfig`, not here.
 */
export interface AnthropicTransportOptions {
  apiKey: string
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

/**
 * Internal type for `createAnthropicAltAdapter` callers (tests).
 * Combines transport with per-task config so existing tests don't have
 * to thread two arguments. New code goes through the operator-facing
 * `anthropicProvider(transport).altText(taskConfig)` chain.
 */
export interface AnthropicAltAdapterOptions extends AnthropicTransportOptions {
  /** Model ID; defaults to {@link ANTHROPIC_DEFAULT_MODEL} when absent. */
  model?: string
  /** Operator-supplied system prompt; prepended to system-composed prompt. */
  systemPrompt?: string
  /** Generation token cap; provider derives from maxChars when absent. */
  maxTokens?: number
}

/** Encode a Uint8Array as a base64 string for the API call. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Construct the Anthropic alt-text adapter. Internal factory — kept
 * public for tests + advanced wiring. Operator-facing config goes
 * through `anthropicProvider(transport).altText(taskConfig)` (Path X).
 */
export function createAnthropicAltAdapter(opts: AnthropicAltAdapterOptions): AltTextAdapter {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: opts.maxRetries,
  })
  const model = opts.model ?? ANTHROPIC_DEFAULT_MODEL

  return buildAltAdapterFromScaffold({
    name: 'anthropic',
    supportedMimes: ANTHROPIC_SUPPORTED_MIMES,
    operatorSystemPrompt: opts.systemPrompt,
    operatorMaxTokens: opts.maxTokens,
    refusalMarkers: ANTHROPIC_REFUSAL_MARKERS,
    isAbortError: err => err instanceof Anthropic.APIUserAbortError,
    async callProvider({ bytes, mime, systemPrompt, maxTokens, signal }) {
      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
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
                    media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                    data: toBase64(bytes),
                  },
                },
              ],
            },
          ],
        },
        { signal },
      )

      // Response shape: `content` is an array of blocks; alt-text comes
      // back as a single text block. Defensive against tool-use blocks
      // or unexpected shapes by finding the first text block.
      const textBlock = response.content.find(block => block.type === 'text')
      if (!textBlock || textBlock.type !== 'text') {
        throw new AIInvalidResponseError('Anthropic response contained no text content block')
      }
      return textBlock.text
    },
  })
}

/**
 * Operator-facing Anthropic provider. Constructs the transport-only
 * `AIProvider` used in `site.config.ts`:
 *
 *   const anthropic = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })
 *   ai: { provider: anthropic, model: 'claude-haiku-4-5' }
 *
 * The provider exposes per-task builders (`.altText({...})`); the
 * resolver supplies the merged `AltTextTaskConfig` from the three-rung
 * inheritance chain at boot.
 */
export function anthropicProvider(transport: AnthropicTransportOptions): AIProvider {
  if (!transport.apiKey) {
    throw new Error('anthropicProvider: "apiKey" is required (typically `process.env.ANTHROPIC_API_KEY!`)')
  }
  return {
    name: 'anthropic',
    altText(taskConfig: AltTextTaskConfig): AltTextAdapter {
      return createAnthropicAltAdapter({
        ...transport,
        model: taskConfig.model,
        systemPrompt: taskConfig.systemPrompt,
        maxTokens: taskConfig.maxTokens,
      })
    },
  }
}
