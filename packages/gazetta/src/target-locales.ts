/**
 * Which languages a target publishes, and where each one is served
 * (design-i18n.md "Target locale rules", #1146).
 *
 * Content files name their language relative to the SITE: `page.json`
 * is the site's default language, `page.fr.json` French. A target names
 * its own default language (`locale`), its languages (`locales`) and
 * whether the default is prefixed (`defaultPrefix`). This module maps
 * one onto the other so publish, the sitemap, the redirects file and
 * removals agree on the URL of every published version.
 */

import { localeRoutePrefix, normalizeLocale, resolveSiteLocales, resolveTargetLocales } from './locale.js'
import type { ResolvedLocales } from './locale.js'
import type { SiteManifest, TargetConfig } from './types.js'

export interface TargetLanguages {
  /** The target's languages, default and prefix rule (inherits from the site). */
  readonly target: ResolvedLocales
  /** The site's default language: the language of `page.json` / `fragment.json`. */
  readonly contentDefault: string
}

/** The target's language rules, or null when the site has no `locales` config. */
export function resolveTargetLanguages(site: SiteManifest, target: TargetConfig | undefined): TargetLanguages | null {
  const siteLocales = resolveSiteLocales(site)
  if (!siteLocales) return null
  const resolved = target ? resolveTargetLocales(target, site) : siteLocales
  if (!resolved) return null
  return { target: resolved, contentDefault: siteLocales.default }
}

/** The language a content file holds: a variant's own, or the site default for the base file. */
export function variantLanguage(languages: TargetLanguages, variant: string | undefined): string {
  return variant ? normalizeLocale(variant) : languages.contentDefault
}

/**
 * The versions of a page a target publishes: `undefined` stands for the
 * base file (`page.json`), a string for a variant. Only the target's
 * languages are published, the site's default language included, so a
 * page with no file in them gives an empty list. Without site locales,
 * the base file and the variants the target's `locales` allows.
 */
export function pageVersionsFor(
  variants: Iterable<string>,
  languages: TargetLanguages | null,
  targetLocales?: readonly string[],
): (string | undefined)[] {
  if (!languages) {
    return [undefined, ...[...variants].filter(v => !targetLocales || targetLocales.includes(v))]
  }
  const supported = languages.target.supported
  const out: (string | undefined)[] = []
  if (supported.includes(languages.contentDefault)) out.push(undefined)
  for (const v of variants) {
    const lang = normalizeLocale(v)
    if (lang !== languages.contentDefault && supported.includes(lang)) out.push(v)
  }
  return out
}

/**
 * The versions of a fragment an ESI target publishes. As for pages, plus
 * the base file always: a page whose language has no version of the
 * fragment reads the base file at request time (design-i18n.md,
 * "Fragment locale resolution").
 */
export function fragmentVersionsFor(
  variants: Iterable<string>,
  languages: TargetLanguages | null,
  targetLocales?: readonly string[],
): (string | undefined)[] {
  const versions = pageVersionsFor(variants, languages, targetLocales)
  return versions.includes(undefined) ? versions : [undefined, ...versions]
}

/**
 * The URL prefix of a published version on this target: `''` for the
 * target's default language (unless `defaultPrefix`), `/fr` otherwise.
 * Without site locales, a variant is prefixed with its own code.
 */
export function versionRoutePrefix(languages: TargetLanguages | null, variant: string | undefined): string {
  if (!languages) return variant ? `/${normalizeLocale(variant)}` : ''
  return localeRoutePrefix(variantLanguage(languages, variant), languages.target)
}

/** The URL prefix of the target's default language: `''`, or `/en` with `defaultPrefix`. */
export function defaultLanguagePrefix(languages: TargetLanguages | null): string {
  return languages ? localeRoutePrefix(languages.target.default, languages.target) : ''
}
