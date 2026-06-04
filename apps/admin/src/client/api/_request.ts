/**
 * Wire-level primitives shared by every API module.
 *
 * This file owns:
 *   - the API base URL derivation (`/admin/api`, `/cms/api`, `/api`)
 *   - the active-target injection (`?target=<name>`) — a cross-cutting
 *     concern that every endpoint honors
 *
 * Auth headers are NOT set client-side. Per design-auth-rbac.md, Gazetta
 * consumes upstream identity from configured request headers populated
 * by the platform's auth layer (Cloudflare Access, Azure Easy Auth,
 * forwarded-user via reverse proxy, etc.). `authHeaders()` is kept as a
 * pass-through so callers stay uniform; do NOT source tokens from
 * sessionStorage / localStorage / cookies here.
 *
 * Nothing here is endpoint-specific. If a behavior would change between
 * "pages API" and "assets API," it does not belong here.
 *
 * Other API modules (`client.ts`, `assets.ts`) import these helpers rather
 * than redefining fetch + active-target plumbing per module.
 */

// API is relative to the CMS base path. `import.meta.env.BASE_URL` resolves
// to `/admin/`, `/cms/`, or `/` depending on how the admin SPA is mounted.
export const API_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') + '/api'

/**
 * Active-target provider — injected at app boot by `setActiveTargetProvider`.
 * Kept as an injected function so the api modules don't depend on the
 * active-target Pinia store at module-load time (DIP).
 */
type ActiveTargetProvider = () => string | null
let activeTargetProvider: ActiveTargetProvider | null = null

/** Wire the api modules to read the active target from the provided source. */
export function setActiveTargetProvider(provider: ActiveTargetProvider | null): void {
  activeTargetProvider = provider
}

/**
 * Append `?target=<active>` to a URL path when the active-target provider
 * is set and the path doesn't already specify a target. Query string is
 * added before any existing `#fragment` (none expected in api URLs).
 */
export function withActiveTarget(path: string): string {
  const name = activeTargetProvider?.()
  if (!name) return path
  // Skip if caller already set ?target= explicitly (e.g., compare destination).
  if (/[?&]target=/.test(path)) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}target=${encodeURIComponent(name)}`
}

/** Read the currently-active target name, if any. Used by callers that
 *  need the value directly (e.g. compare's source fallback). */
export function getActiveTarget(): string | null {
  return activeTargetProvider?.() ?? null
}

/**
 * Auth headers for a fetch call. Pass-through by design — see file header.
 * Kept as a function (not deleted entirely) so the many callers stay
 * uniform if auth-header injection ever moves here from a wrapper layer.
 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return extra
}

/** Build the full absolute URL for an API path, including the active target. */
export function apiUrl(path: string): string {
  return `${API_BASE}${withActiveTarget(path)}`
}
