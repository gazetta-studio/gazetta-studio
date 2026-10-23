/**
 * Derive a public route from a page folder name. Runtime-neutral — shared
 * by the Node server, the Cloudflare worker, and publish tooling.
 *
 *   home        → /
 *   about       → /about
 *   blog/[slug] → /blog/:slug
 */
export function deriveRoute(pageName: string): string {
  if (pageName === 'home') return '/'
  return '/' + pageName.replace(/\[([^\]]+)\]/g, ':$1')
}

/**
 * Substitute `:param` segments in a derived route with the request's
 * captured values. A static page has no captured values and keeps the
 * literal route. When values were captured, a segment without one returns
 * null — there is no URL to redirect to, so the caller answers 410 (#1126).
 */
export function fillRouteParams(route: string, params?: Record<string, string>): string | null {
  if (params === undefined) return route
  let missing = false
  const filled = route.replace(/:([A-Za-z0-9_]+)/g, (segment, name: string) => {
    const value = params[name]
    if (value === undefined) {
      missing = true
      return segment
    }
    return value
  })
  return missing ? null : filled
}
