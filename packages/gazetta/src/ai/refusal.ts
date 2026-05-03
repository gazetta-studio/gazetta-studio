/**
 * Refusal detection for AI provider responses.
 *
 * # Why this lives in `ai/` and not `alt/`
 *
 * Provider safety refusals look the same regardless of task. Whether
 * the model is asked to describe an image (alt-text) or translate a
 * paragraph (future), a refusal arrives as a 200 OK with text like
 * "I can't help with that" in the response body — structurally
 * indistinguishable from a successful response without inspection.
 *
 * v1.5's only consumer is `alt/`, but refusal detection is conceptually
 * cross-task. Right structure now beats right structure later, per
 * [team-preferences rule 18]: "extract shared code when you first see
 * the split concern". Translation as the documented next consumer
 * (per [design-ai-implementation.md]) makes this a known split.
 *
 * # Marker maintenance
 *
 * The marker list below MUST stay current as providers tune their
 * safety messaging. Plan: review at every major model version bump
 * (e.g., when an adapter's `defaultModel` jumps a major). Provider-
 * specific phrases live in the adapter (passed via `adapterMarkers`)
 * so generic markers and provider-specific ones can evolve
 * independently.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "raw text → structured refusal info"
 *   - OCP: per-adapter markers extend without touching the shared list
 *   - DIP: callers depend on `detectRefusal`, not on substring inspection
 *     scattered across the codebase
 */

/**
 * Cross-provider refusal phrases. Lowercase substrings — the matcher
 * lowercases both sides, so casing in the upstream response doesn't
 * matter. Order is irrelevant; `Array.some` is fine at this size.
 *
 * Each entry corresponds to a phrase observed across at least two
 * providers' refusal outputs. Provider-specific phrasing belongs in
 * the adapter, passed via `adapterMarkers`.
 */
const SHARED_REFUSAL_MARKERS: readonly string[] = [
  "i can't describe",
  'i cannot describe',
  "i'm not able to describe",
  'i am not able to describe',
  "i'm unable to describe",
  'i am unable to describe',
  "i can't provide",
  'i cannot provide',
  "i'm unable to provide",
  'i am unable to provide',
  "i can't help",
  'i cannot help',
  "i'm not able to help",
  "i'm sorry, but",
]

/**
 * Minimum useful response length. Below this, even a non-refusal
 * response is too short to be a real description — treat as a refusal
 * with a generic reason. Calibrated for the alt-text use case where
 * five chars is below "Cat." (4) but above "Hi" (2); empty responses
 * also fall through here.
 *
 * If a future task has different length expectations (e.g., a single-
 * word tag), the consumer should normalize the response before passing
 * it to `detectRefusal`, OR the threshold becomes a parameter. Don't
 * generalize speculatively — wait for the second task to force the
 * shape.
 */
const MIN_USEFUL_LENGTH = 5

export interface RefusalDetection {
  refused: boolean
  /** Truncated reason text when refused; null when not. */
  reason: string | null
}

/**
 * Detect whether `text` is a refusal. Caller passes adapter-specific
 * markers (e.g., Anthropic's particular phrasing) on top of the shared
 * list.
 *
 * Returns `{ refused: false, reason: null }` for descriptive responses;
 * `{ refused: true, reason: <truncated text> }` otherwise. Reason is
 * truncated to 200 chars so logs and UI toasts don't render arbitrarily
 * long refusal blocks.
 */
export function detectRefusal(text: string, adapterMarkers: readonly string[] = []): RefusalDetection {
  const lower = text.toLowerCase()
  for (const marker of SHARED_REFUSAL_MARKERS) {
    if (lower.includes(marker)) {
      return { refused: true, reason: text.slice(0, 200) }
    }
  }
  for (const marker of adapterMarkers) {
    if (lower.includes(marker.toLowerCase())) {
      return { refused: true, reason: text.slice(0, 200) }
    }
  }
  if (text.trim().length < MIN_USEFUL_LENGTH) {
    return { refused: true, reason: 'Empty or unusably short response' }
  }
  return { refused: false, reason: null }
}
