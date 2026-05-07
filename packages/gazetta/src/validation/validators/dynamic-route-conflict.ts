import type { PageManifest } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

/**
 * Detect dynamic route ambiguity between pages.
 *
 * Two routes conflict when one's static path would match the other's dynamic
 * pattern. Examples:
 *   - `/blog/hello` (static) and `/blog/:slug` (dynamic) — both match `/blog/hello`
 *   - `/:catch-all` and any static page — overshadows everything
 *
 * Save-delta scope: only flags conflicts INTRODUCED by the save (the saved
 * manifest's route conflicts with an existing page's route). Pre-existing
 * conflicts between two unaffected pages are caught by the background scanner
 * (Cut 2), not save-delta.
 *
 * Only fires for pages.
 */
export const dynamicRouteConflict: Validator = {
  source: 'gazetta',
  name: 'dynamic-route-conflict',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    if (scope.item.kind !== 'page') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    const newRoute = (manifest as PageManifest).route
    if (!newRoute) return []

    const issues: Issue[] = []
    for (const [otherName, other] of site.pages) {
      if (otherName === scope.item.name) continue // skip self
      if (routesConflict(newRoute, other.route)) {
        issues.push({
          validator: 'dynamic-route-conflict',
          severity: 'error',
          message: `Route "${newRoute}" conflicts with existing page "${otherName}" (route "${other.route}").`,
          itemPath: scope.item.itemPath,
        })
      }
    }
    return issues
  },
}

/**
 * Two routes conflict if they could both match the same incoming request path.
 *
 * Compares segment-by-segment:
 *   - Same length required (no wildcard catch-all in current routing)
 *   - Two static segments must match exactly
 *   - One static + one dynamic (`:param`) is a conflict (the static would shadow the dynamic, ambiguity in author intent)
 *   - Two dynamic segments (regardless of name) match the same set of paths — also a conflict
 */
function routesConflict(a: string, b: string): boolean {
  if (a === b) return true
  const ap = a.split('/').filter(Boolean)
  const bp = b.split('/').filter(Boolean)
  if (ap.length !== bp.length) return false
  for (let i = 0; i < ap.length; i++) {
    const aSeg = ap[i]
    const bSeg = bp[i]
    const aDyn = aSeg.startsWith(':')
    const bDyn = bSeg.startsWith(':')
    if (!aDyn && !bDyn) {
      // Two static segments must match exactly to compete.
      if (aSeg !== bSeg) return false
    }
    // static-vs-dynamic and dynamic-vs-dynamic both potentially match same paths,
    // continue checking remaining segments
  }
  return true
}
