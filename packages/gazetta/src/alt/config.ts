/**
 * Alt-text config resolver — composes site `ai:` + site `altText:` +
 * target `altText:` into a single `ResolvedAltConfig`.
 *
 * Inheritance: target wins over site task block, site task block wins
 * over `ai:` base, hardcoded defaults catch absence at the bottom.
 *
 * Pure function — no I/O, no env reads, no SDK construction. The
 * factory in `alt/index.ts` consumes the resolved config + reads
 * env credentials, then builds the adapter.
 *
 * # SOLID
 *
 *   - SRP: this module owns "merge config layers into one resolved
 *     value." Doesn't read env, doesn't construct adapters.
 *   - DIP: factory (next door) depends on this resolved shape, never
 *     on raw `SiteManifest`/`TargetConfig`.
 *   - LSP: resolver is total — every input shape produces either a
 *     `ResolvedAltConfig` or `null`. No exceptions, no surprises.
 */
import { type ResolvedAIBase, resolveAIBase } from '../ai/provider.js'
import type { AIProvider } from '../ai/provider.js'
import { MAX_EDGE } from '../ai/vision-prep.js'
import type { AltTextSiteConfig, AltTextTargetConfig, SiteManifest, TargetConfig } from '../types.js'

/**
 * Per-provider sensible default model. Used when neither `ai.defaultModel`
 * nor `altText.model` is set anywhere in the chain.
 */
const PROVIDER_DEFAULT_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.2-vision:11b',
}

/** Hardcoded default for the `auto` flag. */
const DEFAULT_AUTO = true

/**
 * Fully-resolved alt-text config — what the factory needs to construct
 * an adapter and what the suggester needs to invoke it. No optional
 * fields after this point; defaults applied.
 */
export interface ResolvedAltConfig {
  provider: AIProvider
  /** Concrete model ID. Either explicitly configured or the provider's default. */
  model: string
  /** Whether upload flows auto-fire suggest after upload. */
  auto: boolean
  /** Long-edge cap for vision-call image bytes. */
  maxImageEdge: number
}

/**
 * Resolve alt-text config from site + target. Returns null when no
 * adapter is configured at any layer (no `ai:` block AND no
 * `altText:` block with provider, OR no `altText:` block at all).
 *
 * Resolution order, first-defined-wins:
 *   1. target.altText.{field}
 *   2. site.altText.{field}
 *   3. site.ai.{field}  (only `provider`, `defaultModel`)
 *   4. hardcoded defaults
 */
export function resolveAltConfig(
  site: Pick<SiteManifest, 'ai' | 'altText'>,
  target: Pick<TargetConfig, 'altText'> | undefined,
): ResolvedAltConfig | null {
  const siteAlt: AltTextSiteConfig | undefined = site.altText
  const targetAlt: AltTextTargetConfig | undefined = target?.altText
  const base: ResolvedAIBase | null = resolveAIBase(site)

  // Provider must come from somewhere. If neither the site task block
  // nor the cross-task base specifies one, the feature isn't configured.
  // (Target level can't specify provider — it's behavior-only.)
  const provider = siteAlt?.provider ?? base?.provider
  if (!provider) {
    // No provider configured anywhere → feature is off. The site might
    // still have an `altText:` block with only `auto: true` etc., but
    // that's a misconfiguration; better to surface as "off" than to
    // pick a provider arbitrarily.
    return null
  }

  // Model resolution: target → site task → site base → provider default.
  const model = targetAlt?.model ?? siteAlt?.model ?? base?.defaultModel ?? PROVIDER_DEFAULT_MODELS[provider]

  // Auto: target → site task → hardcoded default.
  const auto = targetAlt?.auto ?? siteAlt?.auto ?? DEFAULT_AUTO

  // Vision sizing: target → site task → hardcoded default (MAX_EDGE).
  const maxImageEdge = targetAlt?.maxImageEdge ?? siteAlt?.maxImageEdge ?? MAX_EDGE

  return { provider, model, auto, maxImageEdge }
}
