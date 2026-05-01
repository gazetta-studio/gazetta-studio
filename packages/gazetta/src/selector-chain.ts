/**
 * Cross-dimension fallback chain resolution.
 *
 * Produces an ordered list of `Selector`s to try, given the active locale
 * + theme and the site's resolved locale + theme configuration. The list
 * is in **most-specific-first** order — callers walk it and apply each
 * variant's overrides on top of the previous (per-field cascade), with the
 * default manifest always read separately as the base.
 *
 * # Locale-priority ordering (locked)
 *
 * For active `(fr, dark)` with site default `(en, light)`:
 *
 *   1. (fr, dark)             — most specific
 *   2. (fr, light)            — locale match, default theme
 *   3. (default-locale, dark) — only theme match
 *   4. (default-locale, light) [the default manifest, read separately]
 *
 * Locale matches first, then theme. Documented in design-media.md and
 * locked during foundation grilling — language matters more for
 * comprehension than visual presentation, so when content has to fall
 * back, it falls back along the theme axis before the locale axis.
 *
 * # Default exclusion
 *
 * The chain never includes the all-default selector (no locale, no theme
 * overrides). That's the base manifest, always read separately. Including
 * it would make every walker double-read the default.
 *
 * Selectors with `theme = default-theme` are also excluded when the
 * default manifest already covers that theme — they would just be
 * duplicate reads. The chain only carries selectors whose stored manifest
 * could plausibly differ from the default.
 *
 * # Single-dimension sites
 *
 * - Site has no themes config → chain has only locale selectors.
 * - Site has themes but no locales → chain has only theme selectors.
 * - Site has both → cross-product, locale-priority.
 *
 * Single responsibility: combine config + active selector → ordered chain.
 * No I/O, no manifest reads, no asset knowledge.
 */
import type { ResolvedLocales } from './locale.js'
import { localeFallbackChain } from './locale.js'
import { buildSelector, type Selector } from './schema/dimensions.js'
import type { ResolvedThemes } from './themes.js'

export interface CrossDimensionInput {
  /** Active locale, if set. When unset, locale dimension contributes nothing. */
  locale?: string
  /** Active theme, if set. When unset, theme dimension contributes nothing. */
  theme?: string
  /** Resolved site locales — null when site is single-locale. */
  locales: ResolvedLocales | null
  /** Resolved site themes — null when site has no theme dimension. */
  themes: ResolvedThemes | null
}

/**
 * Build the most-specific-first list of selectors to read for cross-dimension
 * fallback. Excludes the all-default selector (caller reads default manifest
 * separately as the base).
 */
export function crossDimensionFallbackChain(input: CrossDimensionInput): readonly Selector[] {
  const localeAxis = buildLocaleAxis(input)
  const themeAxis = buildThemeAxis(input)

  const result: Selector[] = []
  // Locale-priority: outer loop is locale (active first, then locale-fallbacks),
  // inner loop is theme (active first, then default-theme).
  for (const locale of localeAxis) {
    for (const theme of themeAxis) {
      const selector = buildSelector({
        ...(locale !== null ? { locale } : {}),
        ...(theme !== null ? { theme } : {}),
      })
      if (selector === null) continue // all-defaults, excluded
      result.push(selector)
    }
  }
  return result
}

/**
 * Locale axis values to try, in order. `null` means "no locale dimension"
 * (default-locale, treated as identity on this axis).
 *
 * - When `locale` is unset OR equals default → `[null]` (no locale variants to try)
 * - When `locale` is non-default → `[active, ...fallbacks, null]`
 *   (try active locale, then configured fallbacks, then drop the locale dimension)
 */
function buildLocaleAxis(input: CrossDimensionInput): readonly (string | null)[] {
  if (!input.locale || !input.locales) return [null]
  if (input.locale === input.locales.default) return [null]
  const chain = localeFallbackChain(input.locale, input.locales)
  return [...chain, null]
}

/**
 * Theme axis values to try, in order. `null` means "no theme dimension"
 * (default-theme, treated as identity on this axis).
 *
 * - When `theme` is unset OR equals default → `[null]`
 * - When `theme` is non-default → `[active, null]`
 *   (try active theme, then drop the theme dimension)
 */
function buildThemeAxis(input: CrossDimensionInput): readonly (string | null)[] {
  if (!input.theme || !input.themes) return [null]
  if (input.theme === input.themes.default) return [null]
  return [input.theme, null]
}
