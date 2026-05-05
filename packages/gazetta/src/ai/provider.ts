/**
 * Cross-task AI primitives — the provider type and shared base config.
 *
 * `AIProvider` is a closed enum. Adding a fourth provider extends it; no
 * other module needs to know the full set (per-task factories switch on
 * it locally). Closed because the v1.5 ship is exactly three: Anthropic,
 * OpenAI, Ollama. Future providers (Gemini, Cloudflare Workers AI) land
 * via additive enum extension + factory case.
 *
 * `ResolvedAIBase` carries fields shared by every AI task. v1.5 has two:
 * `provider` (which SDK to use) and `defaultModel` (per-task override
 * starting point). Vision-task-specific fields like `maxImageEdge` stay
 * on per-task resolved configs — they don't apply to text tasks like a
 * future translation feature, so putting them on the cross-task base
 * would be an ISP violation.
 *
 * See `.claude/rules/design-ai.md` for the three-layer config rationale.
 */

/** Closed enum of providers shipped in v1.5. Extend additively. */
export type AIProvider = 'anthropic' | 'openai' | 'ollama'

/**
 * Cross-task config resolved from `site.config.ts`'s `ai:` block. Per-task
 * resolvers compose this with their own task-specific config.
 */
export interface ResolvedAIBase {
  provider: AIProvider
  /** Per-provider sensible default; tasks may override. */
  defaultModel: string | null
}

/**
 * Resolve the cross-task AI base config from a `SiteManifest`. Returns
 * null when the `ai:` block is absent — per-task resolvers fall back
 * to their own provider field (or report the task as unconfigured).
 *
 * Pure function. No I/O. No env-var reads. Tests pass `SiteManifest`
 * fragments directly.
 */
export function resolveAIBase(site: { ai?: { provider: AIProvider; defaultModel?: string } }): ResolvedAIBase | null {
  if (!site.ai) return null
  return {
    provider: site.ai.provider,
    defaultModel: site.ai.defaultModel ?? null,
  }
}
