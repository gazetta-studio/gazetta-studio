import type { Site } from '../site-loader.js'
import type { FragmentManifest, PageManifest } from '../types.js'

export function lookupManifest(
  site: Site,
  kind: 'page' | 'fragment',
  name: string,
): (PageManifest | FragmentManifest) | undefined {
  return kind === 'page' ? site.pages.get(name) : site.fragments.get(name)
}
