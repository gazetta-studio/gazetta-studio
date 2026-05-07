import type { Issue, Validator, ValidatorInput } from '../types.js'
import { resolveSiteLocales } from '../../locale.js'

/**
 * Detect locale-variant manifests whose locale isn't supported by the site.
 *
 * Concrete cases this catches:
 *   - `page.fr.json` exists but site config omits `fr` from `locales.supported`
 *     (typo, removed locale, or copy-paste leftover)
 *   - Same for `fragment.{loc}.json`
 *
 * Doesn't flag missing-default — `page.json` (default locale) absence with
 * `page.fr.json` present means "French-only page," which is valid (per
 * `design-i18n.md` "Edge cases" — French-only pages are allowed).
 *
 * Background scope only — orphan-locale is a site-wide property of the file
 * tree; save-delta on `page.fr.json` already runs the standard ref validators
 * against the saved variant.
 *
 * Issues surface on the orphaned variant file itself.
 */
export const orphanedLocaleFile: Validator = {
  source: 'gazetta',
  name: 'orphaned-locale-file',
  stages: ['background', 'cli'] as const,

  defaultSeverity() {
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'background' && scope.kind !== 'cli') return []

    const resolved = resolveSiteLocales(site.manifest)
    if (!resolved) return [] // single-locale site — no locale variants to check
    const supported = new Set(resolved.supported)

    if (scope.kind === 'background') {
      // Per-item: only emit if THIS item's locale is unsupported.
      const item = scope.item
      const variants = item.kind === 'page' ? site.pageLocales.get(item.name) : site.fragmentLocales.get(item.name)
      if (!variants) return []
      const issues: Issue[] = []
      for (const [locale, manifest] of variants.locales) {
        if (supported.has(locale)) continue
        const ext = item.kind === 'page' ? 'page' : 'fragment'
        issues.push({
          validator: 'orphaned-locale-file',
          severity: 'warn',
          message: `Locale variant "${locale}" exists but is not in site.locales.supported. Add the locale to site.config.ts or remove the file.`,
          itemPath: `${manifest.dir}/${ext}.${locale}.json`,
        })
      }
      return issues
    }

    // CLI: enumerate every orphan across the site
    const issues: Issue[] = []
    for (const [, entry] of site.pageLocales) {
      for (const [locale, manifest] of entry.locales) {
        if (supported.has(locale)) continue
        issues.push({
          validator: 'orphaned-locale-file',
          severity: 'warn',
          message: `Locale variant "${locale}" exists but is not in site.locales.supported.`,
          itemPath: `${manifest.dir}/page.${locale}.json`,
        })
      }
    }
    for (const [, entry] of site.fragmentLocales) {
      for (const [locale, manifest] of entry.locales) {
        if (supported.has(locale)) continue
        issues.push({
          validator: 'orphaned-locale-file',
          severity: 'warn',
          message: `Locale variant "${locale}" exists but is not in site.locales.supported.`,
          itemPath: `${manifest.dir}/fragment.${locale}.json`,
        })
      }
    }
    return issues
  },
}
