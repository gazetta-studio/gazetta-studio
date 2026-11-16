/**
 * The archived-page rows of a plain-static target's host redirects file
 * (design-soft-delete.md Q10, design-redirects.md). One source for the
 * publish step that writes the file and the validator that warns when a
 * Cloudflare Pages file would pass the host's row limit, so the warning
 * counts the rows publish actually writes (#1149).
 */
import { localeRoutePrefix } from './locale.js'
import { emitRedirects, type ArchiveSummary } from './runtime/redirects-emit.js'
import { allPageEntries, deriveRoute, type Site } from './site-loader.js'
import { resolveTargetLanguages } from './target-locales.js'
import type { SiteManifest, TargetConfig } from './types.js'

/** Static rows Cloudflare Pages reads from `_redirects` (dynamic rows have their own 100). */
export const CLOUDFLARE_REDIRECTS_ROW_LIMIT = 2000

/**
 * One entry per archived page per route the target publishes: a redirect
 * keeps the visitor's language (#1124, #1146). Locale variant entries share the
 * parent's archive state in v1, so rows expand from the default-locale
 * entry.
 */
export function redirectArchives(
  site: Site,
  siteManifest: SiteManifest,
  targetConfig: TargetConfig | undefined,
): ArchiveSummary[] {
  const archives: ArchiveSummary[] = []
  // One row per language the target publishes, at the route its
  // language rules give (#1146). A language with no destination version
  // falls back to the destination's page in the target's default
  // language (#1124 Q10): static publish only writes a language's route
  // when the page has that version.
  const languages = resolveTargetLanguages(siteManifest, targetConfig)
  const rowLanguages = languages ? languages.target.supported : ['']
  const prefixOf = (lang: string) => (languages && lang ? localeRoutePrefix(lang, languages.target) : '')
  const atRoute = (prefix: string, route: string) => (route === '/' ? prefix || '/' : `${prefix}${route}`)
  for (const entry of allPageEntries(site)) {
    if (entry.page.archived !== true) continue
    if (entry.locale) continue
    const baseFrom = deriveRoute(entry.name)
    const baseTo = entry.page.aliasOf ? deriveRoute(entry.page.aliasOf) : undefined
    const destEntry = entry.page.aliasOf ? site.pageLocales.get(entry.page.aliasOf) : undefined
    for (const lang of rowLanguages) {
      const from = atRoute(prefixOf(lang), baseFrom)
      const destHasLang = !languages || lang === languages.contentDefault || (destEntry?.locales.has(lang) ?? false)
      const destLang = destHasLang ? lang : (languages?.target.default ?? '')
      const to = baseTo === undefined ? undefined : atRoute(prefixOf(destLang), baseTo)
      archives.push(to !== undefined ? { from, to } : { from })
    }
  }
  return archives
}

/** Rows in the `_redirects` file a Cloudflare Pages target would get, or null for any other format. */
export function cloudflareRedirectsRowCount(
  site: Site,
  siteManifest: SiteManifest,
  targetConfig: TargetConfig | undefined,
): number | null {
  if (targetConfig?.redirects?.format !== 'cloudflare') return null
  return redirectsRowCount(emitRedirects('cloudflare', redirectArchives(site, siteManifest, targetConfig))?.body ?? '')
}

/** Rows in a `_redirects` body (one per line). */
export function redirectsRowCount(body: string): number {
  return body === '' ? 0 : body.trimEnd().split('\n').length
}

/** The warning both `gazetta publish` and the validator show past the limit. */
export function cloudflareRedirectsLimitMessage(targetName: string, rows: number): string {
  return (
    `Target "${targetName}": _redirects would have ${rows.toLocaleString('en-US')} rows, ` +
    `but Cloudflare Pages reads at most ${CLOUDFLARE_REDIRECTS_ROW_LIMIT.toLocaleString('en-US')} static rows ` +
    '(one per archived page with an alias, per language the target publishes).'
  )
}
