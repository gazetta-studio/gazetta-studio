/**
 * `AltSuggester` — orchestration between callers and adapters.
 *
 * The suggester is **stateless**. No memoization, no per-replica cache.
 * Multi-replica admin correctness > per-replica optimization. If
 * caching ever earns its keep operationally, it lands as a decorator
 * (`CachedAltSuggester`) wrapping this base — additive, multi-replica
 * correct via shared storage.
 *
 * # What the suggester owns
 *
 *   - Build typed `AltRequest` from caller input + defaults
 *   - Compose the prompt via `composePrompt(request, policies)`
 *   - Call `prepareForVision` to resize bytes before adapter call
 *   - Forward `AbortSignal` to adapter
 *   - Return `AltSuggestion | null` — null = call failed (adapter
 *     unavailable, error, etc.)
 *
 * # What it doesn't own
 *
 *   - HTTP / SDK transport (adapter)
 *   - Provider-specific request shape (adapter)
 *   - Refusal detection (adapter calls `detectRefusal` and constructs
 *     the structured `AltSuggestion`; suggester forwards the result)
 *   - Cache (none; future decorator)
 *   - UI concerns (consumer)
 *
 * # Returning null vs. throwing
 *
 * The suggester's contract: returns `AltSuggestion | null`. Null
 * means "call couldn't complete" — the adapter doesn't support the
 * MIME, or threw a transport error, or was canceled. Consumers treat
 * null uniformly (don't auto-fill).
 *
 * Refusals (model said no but we got a response) come back as
 * `AltSuggestion` with `refused: true`. Different from null — the
 * suggester DID complete, the model just declined. Consumers can
 * surface `refusalReason` to the author.
 *
 * # SOLID
 *
 *   - SRP: this module owns one concern (orchestration of the
 *     adapter call from caller input to result/null)
 *   - OCP: caching, retry, throttling all land as decorators wrapping
 *     `AltSuggester` — none requires changing this module
 *   - DIP: depends on `AltTextAdapter` (abstract), uses `prepareForVision`
 *     and `composePrompt` (utilities); no knowledge of any provider
 */
import { composePrompt } from '../ai/compose-prompt.js'
import { AIAdapterUnavailableError, AIError, AIInvalidResponseError } from '../ai/errors.js'
import { prepareForVision } from '../ai/vision-prep.js'
import {
  type AltGenerateInput,
  type AltRequest,
  type AltSuggestion,
  type AltTextAdapter,
  DEFAULT_ALT_REQUEST,
} from './adapter.js'
import { DEFAULT_ALT_PROMPT_POLICIES } from './prompt-policies.js'

export interface SuggestInput {
  /** Source asset bytes. */
  bytes: Uint8Array
  /** Source MIME from manifest. */
  mime: string
  /** For diagnostics (logging); not used for memoization in v1.5. */
  hash: string
  /** Target locale for the description. Default 'en'. */
  locale?: string
  /**
   * For animated images: the analyzer-extracted first-frame poster
   * bytes. The suggester forwards to `prepareForVision` which uses
   * them directly (no re-rasterization).
   */
  posterBytes?: Uint8Array
  /**
   * Per-call max-edge override for vision-prep. Defaults to the
   * `prepareForVision` default (768).
   */
  maxImageEdge?: number
  /** Soft length cap; default 125. */
  maxChars?: number
}

/**
 * The orchestration interface. UI components and route handlers
 * depend on this; the concrete `createAltSuggester` builds an
 * implementation backed by an adapter.
 */
export interface AltSuggester {
  /**
   * True when the wrapped adapter is configured AND supports the
   * given MIME. UI uses this to decide whether to render AI affordances.
   */
  available(mime: string): boolean
  /**
   * Run the alt-text suggestion. Returns the structured result from
   * the adapter (which may have `refused: true`), or null when the
   * call couldn't complete (unavailable, transport error, abort).
   */
  suggest(input: SuggestInput, signal?: AbortSignal): Promise<AltSuggestion | null>
}

export interface CreateAltSuggesterOptions {
  adapter: AltTextAdapter
}

/**
 * Build a suggester wrapping the given adapter. Pure factory — no I/O,
 * no env-var reads. Caller (the route handler or test setup) supplies
 * a fully-constructed adapter.
 *
 * Tests substitute by passing `nullAltAdapter`, a recording mock, or
 * a real adapter with an msw-mocked transport.
 */
export function createAltSuggester(opts: CreateAltSuggesterOptions): AltSuggester {
  const { adapter } = opts

  return {
    available(mime: string): boolean {
      return adapter.supports(mime)
    },

    async suggest(input: SuggestInput, signal?: AbortSignal): Promise<AltSuggestion | null> {
      // Capability check first — adapter may be null-adapter or may
      // not support this MIME. Either way: nothing to attempt.
      if (!adapter.supports(input.mime)) return null

      // Bail on already-aborted signals before doing any work.
      if (signal?.aborted) return null

      // Build the typed request from input + defaults.
      const request: AltRequest = {
        ...DEFAULT_ALT_REQUEST,
        locale: input.locale ?? DEFAULT_ALT_REQUEST.locale,
        maxChars: input.maxChars ?? DEFAULT_ALT_REQUEST.maxChars,
      }

      // Compose prompt and prepare bytes — both pure, both idempotent.
      const prompt = composePrompt(request, DEFAULT_ALT_PROMPT_POLICIES)

      let prepared: { bytes: Uint8Array; mime: string }
      try {
        prepared = await prepareForVision({
          bytes: input.bytes,
          mime: input.mime,
          posterBytes: input.posterBytes,
          maxEdge: input.maxImageEdge,
        })
      } catch {
        // Vision-prep failure (sharp couldn't decode): treat as
        // unavailable. The asset's bytes are presumably corrupt or
        // an unexpected format — not worth calling the model on
        // garbage.
        return null
      }

      const generateInput: AltGenerateInput = {
        bytes: prepared.bytes,
        mime: prepared.mime,
        request,
        prompt,
      }

      try {
        return await adapter.generate(generateInput, signal)
      } catch (err) {
        // AbortSignal-induced rejection: surface as null (call canceled).
        if (signal?.aborted) return null

        // AI errors are expected failure modes — caller maps null →
        // user-facing toast. Re-throwing would force every caller to
        // try/catch around `suggest`, which is exactly what the
        // suggester contract abstracts away.
        if (err instanceof AIError) return null

        // Non-AI errors (programmer bugs, unexpected exceptions)
        // bubble — the suggester doesn't swallow these, since they
        // indicate a real problem worth surfacing.
        throw err
      }
    },
  }
}

// Re-export AI error types so callers/tests can pattern-match without
// importing from `ai/`. Useful during the brief window where adapter
// implementations distinguish unavailable vs. failed vs. invalid-
// response; in practice route handlers only need the suggester's
// null/non-null result.
export { AIAdapterUnavailableError, AIInvalidResponseError }
