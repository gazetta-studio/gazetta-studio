/**
 * Which language a request is for, and which stored file holds it, on an
 * ESI target (design-i18n.md "Target locale rules", #1146). Runtime-neutral:
 * `gazetta serve` and the Cloudflare worker share it.
 *
 * A target names its own languages, default and prefix rule; files are
 * named after the SITE's default language (`index.html`), with other
 * languages in `index.<locale>.html`. So on a French-only target `/about`
 * reads `pages/about/index.fr.html`.
 */

export interface LocaleRouting {
  /** The target's languages (lowercase). Empty: no language routing. */
  readonly locales: readonly string[]
  /**
   * The target's default language, served without a prefix unless
   * `defaultPrefix`. Unset: any listed language is a prefix and an
   * unprefixed path reads `index.html` (the behaviour before #1146).
   */
  readonly defaultLocale?: string
  /** The default language is prefixed too (`/en/about`). */
  readonly defaultPrefix?: boolean
  /** The site's default language: the one stored as `index.html`. Defaults to `defaultLocale`. */
  readonly contentLocale?: string
}

export interface RoutedRequest {
  /** The language prefix the path carried, or undefined for an unprefixed path. */
  readonly locale: string | undefined
  /** The path with the prefix stripped. */
  readonly path: string
  /** The page file name for the request's language (`index.html`, `index.fr.html`). */
  readonly indexFile: string
  /** Whether `indexFile` names a translation, which falls back to `index.html` when missing. */
  readonly translated: boolean
}

/**
 * Split a request path into its language and the page path. A first
 * segment is a language prefix when it's one of the target's languages,
 * other than an unprefixed default.
 */
export function routeRequest(requestPath: string, routing: LocaleRouting): RoutedRequest {
  const { locales, defaultLocale, defaultPrefix } = routing
  const parts = requestPath.split('/').filter(Boolean)
  const first = parts[0]
  const isPrefix =
    first !== undefined &&
    locales.includes(first) &&
    (defaultLocale === undefined || first !== defaultLocale || !!defaultPrefix)
  const locale = isPrefix ? first : undefined
  const path = isPrefix ? '/' + parts.slice(1).join('/') : requestPath
  const language = locale ?? (locales.length > 0 ? defaultLocale : undefined)
  const contentLocale = routing.contentLocale ?? defaultLocale
  const translated = language !== undefined && language !== contentLocale
  return { locale, path, indexFile: translated ? `index.${language}.html` : 'index.html', translated }
}
