/**
 * Alt-text config resolver — composes gazetta-level + site-level + per-target
 * config into a single `ResolvedAltConfig` per [`design-ai.md`](../../../.claude/rules/design-ai.md)
 * "Three-rung inheritance" + Path X Exception A.
 *
 * Three-rung chain (target → site → gazetta), per field:
 *
 *   - `provider` (transport):  target.altText.ai.provider ?? site.ai.provider ?? gazetta.ai.provider
 *   - `model`:                  target.altText.ai.model    ?? site.ai.model    ?? gazetta.ai.model
 *                                ?? PROVIDER_DEFAULT_MODELS[provider.name]
 *   - `systemPrompt`:           target.altText.ai.systemPrompt ?? site.altText.systemPrompt
 *                                ?? gazetta.altText.systemPrompt ?? null
 *   - `maxTokens`:              target.altText.ai.maxTokens    ?? site.altText.maxTokens
 *                                ?? gazetta.altText.maxTokens   ?? undefined
 *   - `auto` (behavior):        target.altText.auto    ?? site.altText.auto    ?? gazetta.altText.auto
 *                                ?? DEFAULT_AUTO
 *   - `maxImageEdge` (behavior): target.altText.maxImageEdge ?? site.altText.maxImageEdge
 *                                ?? gazetta.altText.maxImageEdge ?? MAX_EDGE
 *
 * Behavior fields (`auto`, `maxImageEdge`) live at the root of `altText:`
 * (Exception B); AI fields (provider, model, systemPrompt, maxTokens)
 * live under `altText.ai` at target level (Exception A's third rung).
 *
 * Pure function — no I/O, no env reads, no SDK construction. The factory
 * in `alt/factory.ts` consumes the resolved config + calls
 * `provider.altText({...})` to build the adapter.
 *
 * # SOLID
 *
 *   - SRP: this module owns "merge config layers into one resolved value."
 *     Doesn't read env, doesn't construct adapters.
 *   - DIP: factory depends on this resolved shape, never on raw
 *     `SiteManifest`/`TargetConfig`.
 *   - LSP: resolver is total — every input shape produces either a
 *     `ResolvedAltConfig` or `null`.
 */
import type { AIProvider } from '../ai/provider.js'
import { PROVIDER_DEFAULT_MODELS } from '../ai/provider.js'
import { MAX_EDGE } from '../ai/vision-prep.js'
import type { AltTextSiteConfig, AltTextTargetConfig, GazettaManifest, SiteManifest, TargetConfig } from '../types.js'

/** Hardcoded default for the `auto` flag. */
const DEFAULT_AUTO = true

/**
 * Fully-resolved alt-text config — what the factory needs to construct
 * an adapter and what the suggester needs to invoke it. No optional
 * fields after this point; defaults applied (except `systemPrompt` and
 * `maxTokens` which are legitimately absent when no operator override
 * is configured anywhere in the chain).
 */
export interface ResolvedAltConfig {
  provider: AIProvider
  /** Concrete model ID. Either explicitly configured or per-provider default. */
  model: string
  /** Operator-supplied system prompt; null = use system default only. */
  systemPrompt: string | null
  /** Generation token cap; undefined = provider default. */
  maxTokens: number | undefined
  /** Whether upload flows auto-fire suggest after upload. */
  auto: boolean
  /** Long-edge cap for vision-call image bytes. */
  maxImageEdge: number
}

/**
 * Resolve alt-text config from gazetta + site + target. Returns null
 * when no provider is configured at any layer.
 *
 * `gazetta` is optional — sites without a project-level `gazetta.config.ts`
 * pass `undefined` (or omit the argument).
 */
export function resolveAltConfig(
  site: Pick<SiteManifest, 'ai' | 'altText'>,
  target: Pick<TargetConfig, 'altText'> | undefined,
  gazetta?: Pick<GazettaManifest, 'ai' | 'altText'>,
): ResolvedAltConfig | null {
  const siteAi = site.ai
  const siteAlt: AltTextSiteConfig | undefined = site.altText
  const targetAlt: AltTextTargetConfig | undefined = target?.altText
  const gazettaAi = gazetta?.ai
  const gazettaAlt = gazetta?.altText

  // Provider: target → site → gazetta. If nothing configured anywhere,
  // the feature is off.
  const provider = targetAlt?.ai?.provider ?? siteAi?.provider ?? gazettaAi?.provider
  if (!provider) return null

  // Model: target → site → gazetta → per-provider default.
  const model =
    targetAlt?.ai?.model ?? siteAi?.model ?? gazettaAi?.model ?? PROVIDER_DEFAULT_MODELS[provider.name] ?? null
  if (model === null) {
    // Plugin-supplied provider with no default-model registration AND
    // no operator-supplied model anywhere in the chain. Surface as
    // "feature off" rather than constructing an adapter that will fail
    // at first SDK call.
    return null
  }

  // systemPrompt: target → site → gazetta → null (use system default).
  const systemPrompt = targetAlt?.ai?.systemPrompt ?? siteAlt?.systemPrompt ?? gazettaAlt?.systemPrompt ?? null

  // maxTokens: target → site → gazetta → undefined (provider derives from maxChars).
  const maxTokens = targetAlt?.ai?.maxTokens ?? siteAlt?.maxTokens ?? gazettaAlt?.maxTokens

  // Behavior fields (auto, maxImageEdge): target → site → gazetta → hardcoded defaults.
  const auto = targetAlt?.auto ?? siteAlt?.auto ?? gazettaAlt?.auto ?? DEFAULT_AUTO
  const maxImageEdge = targetAlt?.maxImageEdge ?? siteAlt?.maxImageEdge ?? gazettaAlt?.maxImageEdge ?? MAX_EDGE

  return { provider, model, systemPrompt, maxTokens, auto, maxImageEdge }
}
