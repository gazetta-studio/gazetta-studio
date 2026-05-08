/**
 * Accessibility validator (Validation Cut 3).
 *
 * Runs axe-core (https://github.com/dequelabs/axe-core) against the rendered
 * HTML of each page. axe-core ships ~90 rules covering WCAG 2.1 / 2.2 A + AA;
 * we run a sensible default subset (some rules are too noisy on dynamic
 * content) and surface violations as `warn` at background, `warn` at
 * pre-publish (operator promotes to error via `publishAudit.strict` in Cut 4).
 *
 * jsdom provides the DOM for axe-core to run against. Per-page cost
 * (jsdom parse + axe run) is ~50-100ms at envelope. Acceptable for the
 * background scanner; pre-publish gate is opt-in for heavy validators.
 *
 * Rendered output is supplied via `input.renderedOutput` (Cut 3 contract).
 *
 * # SOLID lenses
 *
 * - SRP: this validator owns the a11y check. Render-for-analysis produces
 *   the bytes; jsdom + axe analyze; the validator translates findings.
 * - DIP: depends on `RenderedOutputAccess` interface, not the renderer.
 * - OCP: rule subset is configurable; new operator-tunable rule sets ship
 *   via per-site config without changing this file.
 */
import axe from 'axe-core'
import { JSDOM } from 'jsdom'
import type { Issue, Validator, ValidatorInput } from '../types.js'

/**
 * Rules we exclude by default. Each is a documented call:
 *   - `region` — fires on every page without a `<main>` / landmark.
 *     Many Gazetta sites use simple landing pages where this is noise.
 *   - `color-contrast` — requires computed styles, which jsdom doesn't
 *     compute reliably. False positives outweigh value in the background
 *     scanner. Operators wanting it run lighthouse at pre-publish (Cut 4).
 *   - `landmark-one-main` — same rationale as `region`.
 *   - `page-has-heading-one` — landing pages legitimately omit h1
 *     (the page name is in the nav / breadcrumb).
 */
const DEFAULT_DISABLED_RULES = ['region', 'color-contrast', 'landmark-one-main', 'page-has-heading-one']

interface AxeResults {
  violations: AxeViolation[]
}

interface AxeViolation {
  id: string
  help: string
  description: string
  helpUrl: string
  impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null
  nodes: AxeNode[]
}

interface AxeNode {
  html: string
  target: string[]
}

export const accessibility: Validator = {
  source: 'gazetta',
  name: 'accessibility',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    // axe findings are warns at every Gazetta stage; operator promotes to
    // error via publishAudit.strict at pre-publish (Cut 4).
    return 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, renderedOutput } = input
    if (scope.kind !== 'background' && scope.kind !== 'pre-publish') return []
    if (!renderedOutput) return []

    const items = scope.kind === 'background' ? [scope.item] : [...scope.items]
    const issues: Issue[] = []
    for (const item of items) {
      if (item.kind !== 'page') continue // fragments are partials, not full HTML
      const html = await renderedOutput.htmlFor(item)
      if (!html) continue
      const violations = await runAxe(html)
      for (const v of violations) {
        for (const node of v.nodes) {
          issues.push({
            validator: 'accessibility',
            severity: 'warn',
            message: `${v.id}: ${v.help} — ${node.target.join(' > ')} (${v.helpUrl})`,
            itemPath: item.itemPath,
          })
        }
      }
    }
    return issues
  },
}

/**
 * Run axe-core against `html` in a fresh jsdom. Returns the list of
 * violations found. Falls back to an empty list on any error — we don't
 * want a parse failure to block the entire scan.
 */
async function runAxe(html: string): Promise<AxeViolation[]> {
  let dom: JSDOM
  try {
    dom = new JSDOM(html, { runScripts: 'outside-only' })
  } catch {
    return []
  }
  try {
    // Inject axe-core into the jsdom window context. axe.source is the
    // bundled JS string; eval'ing it in the window installs `window.axe`.
    dom.window.eval((axe as unknown as { source: string }).source)
    const win = dom.window as unknown as { axe: { run: (ctx?: unknown, opts?: unknown) => Promise<AxeResults> } }
    const results = await win.axe.run(dom.window.document, {
      rules: Object.fromEntries(DEFAULT_DISABLED_RULES.map(id => [id, { enabled: false }])),
    })
    return results.violations ?? []
  } catch {
    return []
  } finally {
    dom.window.close()
  }
}
