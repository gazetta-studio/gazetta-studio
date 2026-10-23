/**
 * Translate a published archive marker into an HTTP response.
 *
 * Runtime-neutral: both `serve.ts` (Node/Bun) and the Cloudflare R2 worker
 * call this immediately after loading a page, before ESI composition.
 *
 *   alias=X → 301 redirect to deriveRoute(X)
 *   gone    → 410 Gone
 *   no marker → null (the page is live; caller continues normally)
 *
 * Archive responses use a short cache window so a re-published alias/gone
 * state propagates quickly (design-soft-delete.md Q10).
 */
import { localeRoutePrefix } from '../locale.js'
import { parseArchiveMarker } from './archive-marker.js'
import { deriveRoute, fillRouteParams } from './derive-route.js'

export const ARCHIVE_CACHE_CONTROL = 'max-age=300'

export interface ArchiveResponseOptions {
  locale?: string
  defaultLocale?: string
  defaultPrefix?: boolean
  /** Values captured from the request's dynamic route segments, substituted
   * into the alias's route. When values were captured and an alias route
   * segment has none, the answer is 410: there is no URL to redirect to
   * (#1126). */
  params?: Record<string, string>
}

export function archiveGoneResponse(): Response {
  return new Response(null, { status: 410, headers: { 'Cache-Control': ARCHIVE_CACHE_CONTROL } })
}

export function archiveResponse(input: Uint8Array | string, options: ArchiveResponseOptions = {}): Response | null {
  const marker = parseArchiveMarker(input)
  if (!marker) return null

  if (marker.kind === 'gone') return archiveGoneResponse()

  const route = fillRouteParams(deriveRoute(marker.target), options.params)
  if (route === null) return archiveGoneResponse()
  const requestLocale = options.locale ?? (options.defaultPrefix ? options.defaultLocale : undefined)
  const localePrefix = requestLocale
    ? localeRoutePrefix(requestLocale, {
        supported: [requestLocale],
        default: options.defaultLocale ?? requestLocale,
        defaultPrefix: options.defaultPrefix ?? false,
        detection: false,
        fallbacks: {},
      })
    : ''
  const location = `${localePrefix}${route === '/' ? '' : route}` || '/'
  if (!location.startsWith('/') || location.startsWith('//') || location.includes('\\')) {
    return archiveGoneResponse()
  }

  try {
    const headers: Record<string, string> = {
      'Cache-Control': ARCHIVE_CACHE_CONTROL,
      Location: encodeURI(location).replace(/#/g, '%23').replace(/\?/g, '%3F'),
    }
    return new Response(null, { status: 301, headers })
  } catch {
    return archiveGoneResponse()
  }
}
