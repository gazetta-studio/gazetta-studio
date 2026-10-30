/**
 * Removing a published item from a target (design-publish-undo.md Q4):
 * the item's own files only - its manifest, its rendered output, its
 * hashed css/js and its per-item sidecars - so the item answers 404.
 * A nested item's folder stays (removing `about` leaves `pages/about/team/`),
 * and no archive marker is ever written.
 */

import { isValidLocale, localeFilename, normalizeLocale } from './locale.js'
import { parsePubSidecarLocale, parsePubSidecarName, parseSidecarLocale, parseSidecarName } from './hash.js'
import { staticPageIndexPath } from './publish-item.js'
import { deriveRoute } from './runtime/derive-route.js'
import type { StorageProvider, TargetType } from './types.js'

export interface PublishRemovalRef {
  readonly kind: 'page' | 'fragment'
  readonly name: string
  /** Remove only this translation; the default version stays. */
  readonly locale?: string
  /**
   * Static-target pages only: the route whose output is deleted.
   * Defaults to `deriveRoute(name)`; a route change passes the old one.
   */
  readonly route?: string
}

export interface RemovalContext {
  readonly targetType: TargetType
  /** The site's supported locales. Static targets keep a translation at `<locale>/<route>/index.html`. */
  readonly locales: readonly string[]
  /** The site's default locale: its output is unprefixed, so it never names a `<locale>/` path. */
  readonly defaultLocale?: string
}

export type RemovalResult =
  | { readonly ok: true; readonly filesRemoved: number }
  | { readonly ok: false; readonly reason: string }

/** Why a ref can't be removed safely, or null when it can. No path is built from a rejected ref. */
function invalidRemovalReason(ref: PublishRemovalRef): string | null {
  if (ref.kind !== 'page' && ref.kind !== 'fragment') return `unknown kind "${String(ref.kind)}"`
  if (!ref.name || ref.name.startsWith('/') || ref.name.split('/').some(s => s === '..' || s === '.' || s === '')) {
    return `invalid name "${ref.name}"`
  }
  if (ref.locale !== undefined && !isValidLocale(ref.locale)) return `invalid locale "${ref.locale}"`
  if (ref.route !== undefined && ref.route.split('/').some(s => s === '..')) return `invalid route "${ref.route}"`
  return null
}

/** The manifest filenames a removal deletes, from the target folder's listing. */
export async function manifestPathsToRemove(storage: StorageProvider, ref: PublishRemovalRef): Promise<string[]> {
  if (invalidRemovalReason(ref)) return []
  const base = ref.kind === 'page' ? 'page' : 'fragment'
  const dir = itemFolder(ref)
  if (ref.locale) {
    const path = `${dir}/${localeFilename(base, ref.locale)}`
    return (await storage.exists(path)) ? [path] : []
  }
  return (await listFiles(storage, dir)).filter(name => isManifestName(name, base)).map(name => `${dir}/${name}`)
}

export async function removeItemFromTarget(
  storage: StorageProvider,
  ref: PublishRemovalRef,
  ctx: RemovalContext,
): Promise<RemovalResult> {
  const invalid = invalidRemovalReason(ref)
  if (invalid) return { ok: false, reason: invalid }

  const dir = itemFolder(ref)
  // Same mapping as publishRun: every target but a dynamic one renders static pages.
  const staticPage = ref.kind === 'page' && ctx.targetType !== 'dynamic'
  const route = ref.route ?? deriveRoute(ref.name)
  const paths: string[] = []

  if (ref.locale) {
    const locale = normalizeLocale(ref.locale)
    const base = ref.kind === 'page' ? 'page' : 'fragment'
    paths.push(`${dir}/${localeFilename(base, locale)}`, `${dir}/index.${locale}.html`)
    if (staticPage) paths.push(staticPageIndexPath(route, locale))
    for (const name of await listFiles(storage, dir)) {
      const hashScope = parseSidecarName(name) ? parseSidecarLocale(name) : null
      const pubScope = parsePubSidecarName(name) ? parsePubSidecarLocale(name) : null
      if (hashScope === locale || pubScope === locale) paths.push(`${dir}/${name}`)
    }
  } else {
    for (const name of await listFiles(storage, dir)) paths.push(`${dir}/${name}`)
    if (staticPage) {
      paths.push(staticPageIndexPath(route))
      for (const loc of ctx.locales) {
        // The default locale's output is unprefixed; `<default>/<route>` would
        // name another page's folder.
        if (loc === ctx.defaultLocale || !isValidLocale(loc)) continue
        paths.push(staticPageIndexPath(route, normalizeLocale(loc)))
      }
    }
  }

  let filesRemoved = 0
  try {
    for (const path of new Set(paths)) {
      if (!(await storage.exists(path))) continue
      await storage.rm(path)
      filesRemoved++
    }
  } catch (err) {
    return { ok: false, reason: `storage delete failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, filesRemoved }
}

function itemFolder(ref: PublishRemovalRef): string {
  return `${ref.kind === 'page' ? 'pages' : 'fragments'}/${ref.name}`
}

/** Files directly in `dir`; subdirectories are nested items and stay. */
async function listFiles(storage: StorageProvider, dir: string): Promise<string[]> {
  try {
    return (await storage.readDir(dir)).filter(e => !e.isDirectory).map(e => e.name)
  } catch {
    return []
  }
}

function isManifestName(name: string, base: string): boolean {
  if (name === `${base}.json`) return true
  const m = new RegExp(`^${base}\\.([^.]+)\\.json$`).exec(name)
  return !!m && isValidLocale(m[1])
}
