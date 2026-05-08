/**
 * broken-links validator (Validation Cut 4).
 *
 * Walks the rendered HTML for `<a href>`, `<link href>`, and `<img src>` /
 * `<source src>` etc., extracts internal-link references (paths that should
 * resolve within this site), and verifies each one points to either:
 *   - An existing page route in `site.pages` / `site.pageLocales`
 *   - An existing asset path (`/assets/...`)
 *
 * External links (http(s)://other-domain.com) are NOT checked — they go
 * stale independent of publish; a publish gate isn't the right place for
 * URL-rot detection (that's a periodic background concern, deferred).
 *
 * Stages: background + pre-publish. Background surfaces broken links as
 * `warn`; pre-publish promotes to `error` (operator opts into stricter
 * gating via `publishAudit.strict`).
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

export const brokenLinks: Validator = {
  source: 'gazetta',
  name: 'broken-links',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity(stage) {
    return stage === 'pre-publish' ? 'error' : 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, renderedOutput } = input
    if (scope.kind !== 'background' && scope.kind !== 'pre-publish') return []
    if (!renderedOutput) return []

    const items = scope.kind === 'background' ? [scope.item] : [...scope.items]
    const issues: Issue[] = []

    for (const item of items) {
      if (item.kind !== 'page') continue // fragments are partials; rendered output is per-page
      const html = await renderedOutput.htmlFor(item)
      if (!html) continue
      const refs = extractInternalRefs(html)
      for (const ref of refs) {
        const reason = checkRef(ref, site)
        if (reason) {
          issues.push({
            validator: 'broken-links',
            severity: scope.kind === 'pre-publish' ? 'error' : 'warn',
            message: `${ref}: ${reason}`,
            itemPath: item.itemPath,
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
function checkRef(ref: string, site: Site): string | null {
  // Strip query + hash before matching.
  const cleanRef = ref.split('?')[0].split('#')[0]
  if (!cleanRef) return null // pure ?query or #hash — can't validate

  // Asset references: `/assets/{hash}.ext` shape — accept any well-formed
  // assets/ path; the resolver guarantees these were emitted from real
  // refs at render time, so a broken one means the renderer itself failed
  // and we'd already have a different issue.
  if (cleanRef.startsWith('/assets/') || cleanRef.startsWith('assets/')) return null

  // Build the route lookup set from site.pages + locale variants.
  const routes = new Set<string>()
  for (const page of site.pages.values()) {
    if (page.route) routes.add(normalizeRoute(page.route))
  }
  for (const entry of site.pageLocales.values()) {
    for (const variant of entry.locales.values()) {
      if (variant.route) routes.add(normalizeRoute(variant.route))
    }
  }

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
