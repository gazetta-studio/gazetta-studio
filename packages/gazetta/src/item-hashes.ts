/**
 * The hash of every page and fragment of a site, per locale, keyed as
 * publish items (`pages/home`, `pages/home:fr`, `fragments/header`): the
 * values a target's `.{hash}.hash` sidecars hold once they're published
 * there. Compare diffs them against a target; a publish request records
 * them for the manifests it would copy (design-review-workflow.md lock 3).
 */
import { fragmentHashLookup } from './fragment-hashes.js'
import { hashManifest } from './hash.js'
import type { Site } from './site-loader.js'

export interface ItemHashOptions {
  readonly templateHashes: Map<string, string>
  readonly assetHashes: Map<string, string>
  /** Static pages bake every fragment; other pages only those nested in inline components. */
  readonly staticTarget: boolean
  /** Hash fragments too (compare leaves them out for static targets, which don't publish them). */
  readonly includeFragments: boolean
}

export function localItemHashes(site: Site, opts: ItemHashOptions): Map<string, string> {
  const { templateHashes, assetHashes } = opts
  const fragmentHashes = fragmentHashLookup(site, templateHashes, assetHashes)
  const pageHashOpts = (locale?: string) => ({
    templateHashes,
    fragmentHashes: fragmentHashes(locale),
    topLevelFragmentsComposedAtRequest: !opts.staticTarget,
    assetHashes,
  })
  const out = new Map<string, string>()
  for (const [name, page] of site.pages) {
    out.set(`pages/${name}`, hashManifest(page, pageHashOpts()))
    const localeEntry = site.pageLocales.get(name)
    if (localeEntry) {
      for (const [locale, localePage] of localeEntry.locales) {
        out.set(`pages/${name}:${locale}`, hashManifest(localePage, pageHashOpts(locale)))
      }
    }
  }
  if (opts.includeFragments) {
    for (const [name, frag] of site.fragments) {
      out.set(
        `fragments/${name}`,
        hashManifest(frag, { templateHashes, fragmentHashes: fragmentHashes(), assetHashes }),
      )
    }
    for (const [name, localeEntry] of site.fragmentLocales) {
      for (const [locale, localeFrag] of localeEntry.locales) {
        out.set(
          `fragments/${name}:${locale}`,
          hashManifest(localeFrag, { templateHashes, fragmentHashes: fragmentHashes(locale), assetHashes }),
        )
      }
    }
  }
  return out
}
