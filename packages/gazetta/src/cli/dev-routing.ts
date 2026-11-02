/**
 * Where `gazetta dev` sends a request: to the admin API (Hono), to Vite
 * for the admin SPA, or, while Vite is still starting, to the loader page.
 *
 * The admin API, preview and theme don't need Vite, so they answer as soon
 * as the server listens. Only the SPA waits for Vite's first dependency
 * bundle, which can take a minute on a loaded machine (#1716).
 */
export type DevRoute = 'ping' | 'hono' | 'vite' | 'loader'

/** Paths the Hono app serves under `/admin`, without Vite. */
export function servedByHono(url: string): boolean {
  return (
    url.startsWith('/admin/api') ||
    url.startsWith('/admin/preview') ||
    url === '/admin/theme.css' ||
    url.startsWith('/admin/theme.css?')
  )
}

/** The route for `url`; `cmsReady` is whether Vite has finished starting. */
export function devRoute(url: string, cmsReady: boolean): DevRoute {
  if (url === '/admin/ping' || url.startsWith('/admin/ping?')) return 'ping'
  if (servedByHono(url)) return 'hono'
  if (url === '/admin' || url.startsWith('/admin/') || url.startsWith('/@')) return cmsReady ? 'vite' : 'loader'
  return 'hono'
}
