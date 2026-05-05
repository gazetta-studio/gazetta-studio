/**
 * Alt-text adapter factory — the single seam between configuration
 * (env + `site.config.ts`) and adapter construction.
 *
 * Two functions:
 *
 *   - `buildAltAdapter(site, target)` — returns a fully-constructed
 *     `AltTextAdapter`. Returns `nullAltAdapter` when no adapter is
 *     configured OR credentials are missing. Always returns a valid
 *     adapter (never null) so consumers don't null-check.
 *
 *   - `isAltAdapterConfigured(site, target)` — pure config-introspection
 *     for the capability check exposed via `/api/targets`. Doesn't
 *     construct an adapter; just reports whether one *would* be
 *     buildable. Cheap; safe to call on every targets-list response.
 *
 * # Why split into two functions
 *
 * The factory and the capability check answer different questions:
 *   - Factory: "give me an adapter to call right now"
 *   - Capability: "should the UI render AI affordances on this target?"
 *
 * The capability check shouldn't allocate SDK clients (every call to
 * `/api/targets` would). The factory shouldn't be cheap (it constructs
 * SDK clients with retries, base URLs, etc.).
 *
 * Splitting at this seam is SRP: factory owns construction; capability
 * function owns introspection. Both consume the same `resolveAltConfig`
 * output for consistency.
 *
 * # Why no boot-time validation
 *
 * Per the design (Q6 → A′): no eager construction at admin boot. If a
 * target's API key is missing, the route returns 503 at first call;
 * the UI hides affordances via the capability flag. This mirrors the
 * cloudflare TransformAdapter posture (errors at first use, not at
 * boot) and keeps `gazetta dev` startable when only some targets are
 * fully configured.
 *
 * # Env-var contract
 *
 * Process-level credentials only. `.env.local` (gitignored) is the
 * canonical home; per-target API keys are NOT supported in v1.5.
 *
 *   - anthropic → ANTHROPIC_API_KEY
 *   - openai    → OPENAI_API_KEY
 *   - ollama    → no key; OLLAMA_BASE_URL optional override
 *
 * Adapters never read `process.env` directly. The factory reads;
 * adapters take literal values. Tests pass literal values; production
 * goes through the factory.
 */
import { createAnthropicAltAdapter } from './anthropic.js'
import { createOllamaAltAdapter } from './ollama.js'
import { createOpenAIAltAdapter } from './openai.js'
import { nullAltAdapter } from './null-adapter.js'
import { type ResolvedAltConfig, resolveAltConfig } from './config.js'
import type { AltTextAdapter } from './adapter.js'
import type { SiteManifest, TargetConfig } from '../types.js'

/**
 * True when the resolved alt-text config has all required credentials.
 * Pure: returns the structural state — does NOT verify the credential
 * works (i.e., doesn't make a network call). Verification surfaces at
 * first use of the route.
 *
 * Reads `process.env` for credentials. Used by `/api/targets` to set
 * `altText.available`.
 */
export function isAltAdapterConfigured(
  site: Pick<SiteManifest, 'ai' | 'altText'>,
  target: Pick<TargetConfig, 'altText'> | undefined,
): boolean {
  const resolved = resolveAltConfig(site, target)
  if (!resolved) return false
  return hasCredentials(resolved.provider)
}

/**
 * Construct the alt-text adapter for the resolved config. Returns the
 * null adapter when:
 *   - No `ai:` / `altText:` block in `site.config.ts`
 *   - Credentials missing for the configured provider
 *
 * Always returns an `AltTextAdapter` — consumers never null-check the
 * factory's return value. The null adapter throws if `generate()` is
 * called, but that only happens if a consumer skips the
 * `supports()` / `available()` capability check.
 */
export function buildAltAdapter(
  site: Pick<SiteManifest, 'ai' | 'altText'>,
  target: Pick<TargetConfig, 'altText'> | undefined,
): AltTextAdapter {
  const resolved = resolveAltConfig(site, target)
  if (!resolved) return nullAltAdapter

  switch (resolved.provider) {
    case 'anthropic':
      return buildAnthropic(resolved)
    case 'openai':
      return buildOpenAI(resolved)
    case 'ollama':
      return buildOllama(resolved)
  }
}

function buildAnthropic(resolved: ResolvedAltConfig): AltTextAdapter {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return nullAltAdapter
  return createAnthropicAltAdapter({ apiKey, model: resolved.model })
}

function buildOpenAI(resolved: ResolvedAltConfig): AltTextAdapter {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return nullAltAdapter
  return createOpenAIAltAdapter({ apiKey, model: resolved.model })
}

function buildOllama(resolved: ResolvedAltConfig): AltTextAdapter {
  // Ollama needs no API key. The optional OLLAMA_BASE_URL env var is the
  // only env-driven config; everything else comes from `resolved`.
  return createOllamaAltAdapter({
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: resolved.model,
  })
}

/**
 * Cheap credential check. Returns true if the provider's required
 * credentials are present in `process.env`. Ollama needs nothing —
 * always true.
 *
 * Kept private; consumers go through `isAltAdapterConfigured` which
 * also resolves config first.
 */
function hasCredentials(provider: ResolvedAltConfig['provider']): boolean {
  switch (provider) {
    case 'anthropic':
      return Boolean(process.env.ANTHROPIC_API_KEY)
    case 'openai':
      return Boolean(process.env.OPENAI_API_KEY)
    case 'ollama':
      return true
  }
}
