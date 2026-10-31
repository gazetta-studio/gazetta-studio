/**
 * Accessibility scans of the admin UI — testing-plan.md Priority 2.3.
 *
 * The admin's components (Reka UI primitives) are checked one by one by
 * the Storybook axe gate; the screens built from them (env-colored
 * indicators, read-only badges, unified Publish panel, history UI) are
 * checked here.
 *
 * Strategy: scan each major surface with @axe-core/playwright and fail
 * on any *new* violations not in the baseline allowlist. The baseline
 * captures what the first scan found on 2026-04-16 — entries must be
 * removed (not added) over time as fixes land. This is the standard
 * pattern for introducing a11y tests into an existing codebase without
 * blocking on a big-bang fix: regressions fail CI immediately, known
 * debt is tracked and shrinking.
 *
 * Automated scans catch an estimated 30-40% of real WCAG issues. This
 * is the floor, not the ceiling. Scoped to `wcag2a wcag2aa wcag21a
 * wcag21aa`: the admin's target is WCAG 2.1 AA.
 */
import { test, expect } from './fixtures'
import { AxeBuilder } from '@axe-core/playwright'

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

/**
 * Known violations to ignore for now. Each entry needs a rule id and a
 * short reason. Remove entries as fixes land — don't add without a
 * corresponding tracking note. Entries here are per-rule (not per-node)
 * because the blast radius of each is typically across the admin: e.g.
 * "color-contrast" fails on any tinted text below 4.5:1 ratio, which
 * the dark-mode token work hasn't reached yet.
 */
const BASELINE: Array<{ id: string; reason: string }> = [
  // { id: 'color-contrast', ... } — TEMPORARILY removed to surface offenders
]

type Violation = { id: string; impact?: string | null; help: string; helpUrl: string; nodes: unknown[] }

function newViolations(all: Violation[]): Violation[] {
  const known = new Set(BASELINE.map(b => b.id))
  return all.filter(v => !known.has(v.id))
}

async function scan(page: import('@playwright/test').Page) {
  // Exclude the preview iframe — it renders the user's site (in tests:
  // examples/starter), not Gazetta's admin chrome. WCAG violations in
  // the rendered site are the site author's concern, not ours; mixing
  // them into the admin a11y scan would couple admin CI to whatever
  // the starter template happens to set for its colors. Scan stays
  // scoped to the admin SPA only.
  return new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude('iframe[data-testid="preview-iframe"]').analyze()
}

test.describe('accessibility', () => {
  test('site tree view has no new WCAG violations', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.locator('[data-testid="site-page-home"]')).toBeVisible()

    const results = await scan(page)
    const fresh = newViolations(results.violations)
    expect(fresh, formatViolations(fresh)).toEqual([])
  })

  test('page editor view has no new WCAG violations', async ({ page }) => {
    await page.goto('/admin/pages/home/edit')
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })

    const results = await scan(page)
    const fresh = newViolations(results.violations)
    expect(fresh, formatViolations(fresh)).toEqual([])
  })

  test('Publish panel has no new WCAG violations', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.locator('[data-testid="site-page-home"]')).toBeVisible()
    await page.locator('[data-testid="publish-btn"]').click()
    // Publish panel is a Dialog — rendered into body via Teleport.
    await page.waitForSelector('[data-testid="publish-panel"]', { timeout: 5000 })

    const results = await scan(page)
    const fresh = newViolations(results.violations)
    expect(fresh, formatViolations(fresh)).toEqual([])
  })

  test('active target indicator + switcher menu has no new WCAG violations', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.locator('[data-testid="active-target-indicator"]')).toBeVisible()
    await page.locator('[data-testid="active-target-indicator"]').click()
    // The menu content is rendered on open — wait for it in the DOM.
    await page.waitForSelector('[data-testid="active-target-menu"]', { timeout: 3000 })

    const results = await scan(page)
    const fresh = newViolations(results.violations)
    expect(fresh, formatViolations(fresh)).toEqual([])
  })
})

/**
 * Render axe violations as a readable failure message — the default
 * deep-equal diff is unreadable for multi-violation output. Each entry
 * gets rule id, impact, affected node count, and the help URL.
 */
function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return 'No violations'
  return (
    '\n' +
    violations
      .map(v => `  [${v.impact ?? 'unknown'}] ${v.id} — ${v.help}\n    ${v.nodes.length} node(s)\n    ${v.helpUrl}`)
      .join('\n') +
    '\n'
  )
}
