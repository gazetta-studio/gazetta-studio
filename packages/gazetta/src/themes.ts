/**
 * Theme resolution — single source of truth for theme configuration.
 *
 * Mirrors `locale.ts` for the theme dimension. Themes are an asset-override
 * axis introduced in v1: each asset can carry per-theme byte overrides
 * (typically `light` / `dark`) that the resolver picks per render context.
 *
 * Single responsibility: given a `SiteManifest`, return the resolved theme
 * settings (supported list, default). Validation rules. Nothing about
 * assets, manifests, or rendering — those are the resolver's concern.
 *
 * # Why a separate module from locale.ts
 *
 * Themes and locales are peer dimensions in the abstract model but they
 * have different ergonomics: locale codes are open (BCP 47, thousands of
 * valid values), theme codes are closed by convention (typically two or
 * three names per site). The resolution logic is similar enough to feel
 * shared and different enough to warrant separate modules — extracting
 * a shared "dimension config" abstraction would couple them in ways that
 * hurt clarity.
 */
import type { SiteManifest, ThemesConfig } from './types.js'
import { isValidLocale } from './locale.js'

/** Resolved theme settings for a site. */
export interface ResolvedThemes {
  /** All supported theme names, normalized to lowercase. */
  supported: string[]
  /** The default theme name. */
  default: string
}

/**
 * Theme name pattern: lowercase ASCII letters, digits, hyphens, underscores.
 * No dots (collide with filename composition), no whitespace, non-empty.
 */
const THEME_PATTERN = /^[a-z][a-z0-9_-]*$/

/**
 * Validate a theme name as it would appear in storage / filenames.
 *
 * Strict on input — does NOT normalize. Mixed case, leading dots, etc.
 * fail. Callers that want lenient parsing should `normalizeTheme` first
 * and then check.
 *
 * Rejects:
 *   - empty / whitespace
 *   - dots (would collide with filename suffix scheme)
 *   - any uppercase character (filenames must be normalized to lowercase
 *     before reaching storage; uppercase reaching this validator is a bug)
 *   - BCP 47 locale codes (would be ambiguous in filename composition —
 *     `hero.asset.en.json` could be locale `en` or theme `en`)
 */
export function isValidTheme(theme: string): boolean {
  if (!THEME_PATTERN.test(theme)) return false
  // Theme names must not collide with valid BCP 47 locale codes.
  // `en`, `fr`, `pt-br`, etc. are reserved for the locale dimension.
  if (isValidLocale(theme)) return false
  return true
}

/** Normalize a theme name to lowercase for filenames. */
export function normalizeTheme(theme: string): string {
  return theme.toLowerCase()
}

/**
 * Resolve theme settings from a site manifest. Throws when the config is
 * present but invalid (collision with locale codes, malformed names) so
 * misconfiguration surfaces at boot rather than silently at render time.
 *
 * Returns `null` when `themes` is unset — that's the "no theme dimension
 * for this site" signal. Asset overrides keyed by theme are rejected
 * downstream when this is null.
 */
export function resolveSiteThemes(site: SiteManifest): ResolvedThemes | null {
  const config = site.themes
  if (!config) return null

  if (!Array.isArray(config.supported) || config.supported.length === 0) {
    throw new Error('themes.supported must be a non-empty array of theme names')
  }

  const supported: string[] = []
  for (const raw of config.supported) {
    const norm = normalizeTheme(raw)
    if (!isValidTheme(norm)) {
      throw new Error(
        `Invalid theme name "${raw}". Must be lowercase ASCII (a-z, 0-9, -, _), ` +
          `start with a letter, and not collide with BCP 47 locale codes.`,
      )
    }
    if (supported.includes(norm)) {
      throw new Error(`Duplicate theme name "${norm}" in themes.supported`)
    }
    supported.push(norm)
  }

  const defaultRaw = config.default ?? supported[0]!
  const defaultTheme = normalizeTheme(defaultRaw)
  if (!supported.includes(defaultTheme)) {
    throw new Error(`themes.default "${config.default}" is not in themes.supported [${supported.join(', ')}]`)
  }

  return { supported, default: defaultTheme }
}

/**
 * Subset themes to a config — used when a target overrides the site's theme
 * set. Falls back to the site's resolved themes when the target doesn't
 * narrow.
 *
 * v1 doesn't expose target-level theme override (assets are global to the
 * site's theme set). The function is here for symmetry with locale
 * resolution and future-proofs the API when targets may want to ship a
 * subset (e.g. a target that only serves light mode).
 */
export function resolveTargetThemes(siteThemes: ResolvedThemes | null, override?: ThemesConfig): ResolvedThemes | null {
  if (override) return resolveSiteThemes({ name: '', themes: override } as SiteManifest)
  return siteThemes
}
