/**
 * Alt-text adapter factory — the single seam between configuration
 * (gazetta + site + target manifests) and adapter construction.
 *
 * Per Phase 4 of the Path X migration: operator constructs the
 * `AIProvider` instance via a factory call (`anthropicProvider({...})`)
 * inside `defineSite({...})` or `defineGazetta({...})`. The resolver
 * walks the three-rung chain (target → site → gazetta) and the factory
 * delegates to `provider.altText(taskConfig)` to build the adapter.
 *
 * No env-var reads in this module — operators pass `process.env.X!` to
 * the provider factory at config-eval. No SDK side effects at boot:
 * provider authors document construction-time semantics; convention is
 * that providers build SDK config objects at construction and defer
 * network/auth to first method call.
 *
 * Two functions:
 *
 *   - `buildAltAdapter(site, target, gazetta?)` — returns a fully-
 *     constructed `AltTextAdapter`. Returns `nullAltAdapter` when no
 *     adapter is configured anywhere in the chain.
 *
 *   - `isAltAdapterConfigured(site, target, gazetta?)` — pure
 *     introspection for the capability check exposed via `/api/targets`.
 *     Doesn't construct an adapter.
 *
 * # Why split into two functions
 *
 * The factory and the capability check answer different questions:
 *   - Factory: "give me an adapter to call right now"
 *   - Capability: "should the UI render AI affordances on this target?"
 *
 * The capability check shouldn't allocate SDK clients (every call to
 * `/api/targets` would). Splitting at this seam is SRP.
 */
import { resolveAltConfig } from './config.js'
import { nullAltAdapter } from './null-adapter.js'
import type { AltTextAdapter } from './adapter.js'
import type { GazettaManifest, SiteManifest, TargetConfig } from '../types.js'

/**
 * True when the resolved alt-text config has all required pieces.
 * Pure: returns the structural state — does NOT verify the credential
 * works (no network call). Verification surfaces at first use of the route.
 */
export function isAltAdapterConfigured(
  site: Pick<SiteManifest, 'ai' | 'altText'>,
  target: Pick<TargetConfig, 'altText'> | undefined,
  gazetta?: Pick<GazettaManifest, 'ai' | 'altText'>,
): boolean {
  return resolveAltConfig(site, target, gazetta) !== null
}

/**
 * Construct the alt-text adapter for the resolved config. Returns the
 * null adapter when no provider is configured at any layer.
 *
 * Always returns an `AltTextAdapter` — consumers never null-check the
 * factory's return value. The null adapter throws if `generate()` is
 * called, but that only happens if a consumer skips the
 * `supports()` / `available()` capability check.
 */
export function buildAltAdapter(
  site: Pick<SiteManifest, 'ai' | 'altText'>,
  target: Pick<TargetConfig, 'altText'> | undefined,
  gazetta?: Pick<GazettaManifest, 'ai' | 'altText'>,
): AltTextAdapter {
  const resolved = resolveAltConfig(site, target, gazetta)
  if (!resolved) return nullAltAdapter

  // Build the per-task adapter via the provider's `.altText()` builder.
  // Provider supplies transport (apiKey, baseUrl, etc.) from its
  // construction; we supply per-task config (model, systemPrompt,
  // maxTokens) from the resolver chain.
  return resolved.provider.altText({
    model: resolved.model,
    systemPrompt: resolved.systemPrompt ?? undefined,
    maxTokens: resolved.maxTokens,
  })
}
