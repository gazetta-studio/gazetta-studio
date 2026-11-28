/**
 * broken-links validator (Validation Cut 4).
 *
 * Walks the rendered HTML for `<a href>`, `<link href>`, and `<img src>` /
 * `<source src>` etc., extracts internal-link references (paths that should
 * resolve within this site), and verifies each one points to either:
 *   - An existing page route in `site.pages` / `site.pageLocales`
 *   - An asset path (`/assets/...`) other than the placeholder the resolver
 *     renders for a missing asset (`MISSING_ASSET_URLS`)
 *
 * External links (http(s)://other-domain.com) are NOT checked — they go
 * stale independent of publish; a publish gate isn't the right place for
 * URL-rot detection (that's a periodic background concern, deferred).
 *
 * Stages: background + pre-publish. Severity is uniformly `warn`;
 * operators who want broken links to block publish opt into
 * `publishAudit.strict` on the destination target — strict promotion
 * in the publish-audit orchestrator turns warns into errors at the
 * gate (matches the validator matrix in `design-validation.md`).
 *
 * Rendered output is supplied via `input.renderedOutput` (Cut 3 contract).
 *
 * # SOLID lenses
 *
 *   - SRP: this validator owns broken-link detection. Render-for-analysis
 *     produces the bytes; this consumes them.
 *   - DIP: depends on `RenderedOutputAccess` interface, not the renderer.
 *   - OCP: external-link rot detection ships as a separate validator
 *     (e.g., `link-rot`) when concrete demand surfaces; this one stays
 *     focused on internal integrity.
 */
import { JSDOM } from 'jsdom'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import type { Site } from '../../site-loader.js'
import { MISSING_ASSET_URLS } from '../../assets/resolve.js'

export const brokenLinks: Validator = {
  source: 'gazetta',
  name: 'broken-links',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    // Per design-validation.md "Stage × validator matrix": broken-links
    // is warn at every stage. Operators who want it to block publish
    // opt into publishAudit.strict on the destination target — strict
    // promotion in the publish-audit orchestrator turns warns into
    // errors. The validator itself stays uniformly warn.
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, renderedOutput } = input
    if (scope.kind !== 'background' && scope.kind !== 'pre-publish') return []
    if (!renderedOutput) return []

    const items = scope.kind === 'background' ? [scope.item] : [...scope.items]
    const issues: Issue[] = []
    let routes: ReadonlySet<string> | undefined

    for (const item of items) {
      if (item.kind !== 'page') continue // fragments are partials; rendered output is per-page
      const html = await renderedOutput.htmlFor(item)
      if (!html) continue
      const refs = extractInternalRefs(html)
      for (const ref of refs) {
        const reason = checkRef(ref, () => (routes ??= collectRoutes(site)))
        if (reason) {
          issues.push({
            validator: 'broken-links',
            severity: 'warn',
            message: `${ref}: ${reason}`,
            itemPath: item.itemPath,
            // The link as written, so `--base` tells two broken links on one page apart (#1756).
            subject: ref,
          })
        }
      }
    }
    return issues
  },
}

/**
 * Extract internal href / src values from rendered HTML. "Internal" means:
 *   - relative ("/about", "../foo", "page.html")
 *   - same-origin absolute (rare in our render output, but just in case)
 *
 * External links (`http://`, `https://`, `mailto:`, etc.) and anchor-only
 * links (`#section`) are filtered out.
 */
function extractInternalRefs(html: string): readonly string[] {
  let dom: JSDOM
  try {
    dom = new JSDOM(html)
  } catch {
    return []
  }
  const out: string[] = []
  try {
    const selectors = ['a[href]', 'link[href]', 'img[src]', 'source[src]', 'video[src]', 'audio[src]', 'script[src]']
    for (const sel of selectors) {
      for (const el of dom.window.document.querySelectorAll(sel)) {
        const attr = el.hasAttribute('href') ? 'href' : 'src'
        const value = el.getAttribute(attr)
        if (!value) continue
        if (isInternal(value)) out.push(value)
      }
    }
  } finally {
    dom.window.close()
  }
  return out
}

function isInternal(value: string): boolean {
  // Anchor-only.
  if (value.startsWith('#')) return false
  // Pseudo-protocols.
  if (/^(?:mailto|tel|javascript|data):/i.test(value)) return false
  // Absolute URL with scheme — external by definition.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  // Protocol-relative URL — external.
  if (value.startsWith('//')) return false
  return true
}

/**
 * Check one internal reference against the site. Returns null when valid,
 * a human-readable reason when broken.
 */
function checkRef(ref: string, getRoutes: () => ReadonlySet<string>): string | null {
  // Strip query + hash before matching.
  const cleanRef = ref.split('?')[0].split('#')[0]
  if (!cleanRef) return null // pure ?query or #hash — can't validate

  if (cleanRef.startsWith('/assets/') || cleanRef.startsWith('assets/')) {
    if (MISSING_ASSET_URLS.has(normalizeRoute(cleanRef))) return 'asset does not exist'
    // Other asset paths aren't checked: the site doesn't list asset files.
    return null
  }

  const routes = getRoutes()

  // Exact match against a known route.
  const target = normalizeRoute(cleanRef)
  if (routes.has(target)) return null

  // Dynamic-route patterns like `/blog/:slug` — accept any path that matches
  // the pattern's static prefix.
  for (const route of routes) {
    if (matchesDynamicRoute(target, route)) return null
  }

  return `link does not match any page route or asset path`
}

/** Every page route, locale variants included, normalized for lookup. */
function collectRoutes(site: Site): ReadonlySet<string> {
  const routes = new Set<string>()
  for (const page of site.pages.values()) {
    if (page.route) routes.add(normalizeRoute(page.route))
  }
  for (const entry of site.pageLocales.values()) {
    for (const variant of entry.locales.values()) {
      if (variant.route) routes.add(normalizeRoute(variant.route))
    }
  }
  return routes
}

function normalizeRoute(path: string): string {
  if (!path.startsWith('/')) path = '/' + path
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * Test whether `target` (concrete path) could match `pattern` (with `:param`
 * placeholders). Same length + every segment is either equal or pattern has
 * `:` prefix.
 */
function matchesDynamicRoute(target: string, pattern: string): boolean {
  if (!pattern.includes(':')) return false
  const ts = target.split('/').filter(Boolean)
  const ps = pattern.split('/').filter(Boolean)
  if (ts.length !== ps.length) return false
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) continue
    if (ps[i] !== ts[i]) return false
  }
  return true
}
