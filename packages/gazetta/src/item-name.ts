import { isValidLocale } from './locale.js'

/**
 * Item names (pages, fragments, assets) become folder paths under their
 * collection, so a name must stay inside it: no leading `/`, no
 * backslash, and no empty, `.` or `..` segment. `/` is allowed between
 * segments for nested items (`blog/post`).
 */
export function isSafeItemName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\')) return false
  return name.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

export const UNSAFE_ITEM_NAME_MESSAGE = "Names can't be empty, start with /, contain \\, or have an empty, . or .. part"

export interface ItemPath {
  /** The collection folder, or null for an asset-style bare name. */
  folder: 'pages' | 'fragments' | 'templates' | 'assets' | null
  name: string
  /** Only pages and fragments carry a `:locale` suffix. */
  locale?: string
}

/**
 * Parses a publish item string: `pages/<name>[:<locale>]`,
 * `fragments/<name>[:<locale>]`, `templates/<name>`, `assets/<name>` or
 * a bare asset-style name. Returns null when the name isn't safe
 * (isSafeItemName) or a locale suffix isn't a valid locale, so no path
 * is ever built from such an item.
 */
export function parseItemPath(item: string): ItemPath | null {
  if (item.startsWith('/') || item.includes('\\')) return null
  const m = /^(pages|fragments|templates|assets)\/(.+)$/.exec(item)
  const folder = m ? (m[1] as ItemPath['folder']) : null
  let name = m ? m[2] : item
  let locale: string | undefined
  if (folder === 'pages' || folder === 'fragments') {
    const ci = name.indexOf(':')
    if (ci >= 0) {
      locale = name.slice(ci + 1)
      if (!isValidLocale(locale)) return null
      name = name.slice(0, ci)
    }
  }
  if (!isSafeItemName(name)) return null
  return locale === undefined ? { folder, name } : { folder, name, locale }
}
