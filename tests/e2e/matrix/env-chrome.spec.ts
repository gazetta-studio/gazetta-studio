/**
 * Matrix test — environment chrome + read-only badge across all 8
 * target-matrix axis combinations. Runs against the target-matrix
 * fixture site (tests/fixtures/sites/target-matrix/) so each row
 * tests a real live target, not a mocked one.
 *
 * Axis coverage (see site.config.ts):
 *   environment: local | staging | production
 *   editable:    true  | false
 *   type:        static | dynamic
 *
 * What this proves:
 *   - env-{local,staging,production} class flows from target.environment
 *     through to the active-target-indicator regardless of editable/type
 *   - read-only badge shown iff target.editable === false
 *   - The switcher menu lists every target and chrome follows on switch
 */
import { test, expect } from '@playwright/test'

/**
 * One row per target in tests/fixtures/sites/target-matrix/site.config.ts.
 * Kept deliberately exhaustive so a new axis-behavior becomes a single
 * data-table entry, not a new test.
 */
const matrix = [
  { name: 'local-edit', env: 'local', editable: true, chromeClass: 'env-local', readOnly: false },
  { name: 'local-ro', env: 'local', editable: false, chromeClass: 'env-local', readOnly: true },
  { name: 'local-dyn', env: 'local', editable: true, chromeClass: 'env-local', readOnly: false },
  { name: 'staging-ro', env: 'staging', editable: false, chromeClass: 'env-staging', readOnly: true },
  { name: 'staging-edit', env: 'staging', editable: true, chromeClass: 'env-staging', readOnly: false },
  { name: 'prod-ro', env: 'production', editable: false, chromeClass: 'env-production', readOnly: true },
  { name: 'prod-edit', env: 'production', editable: true, chromeClass: 'env-production', readOnly: false },
  { name: 'prod-dyn', env: 'production', editable: false, chromeClass: 'env-production', readOnly: true },
] as const

test.describe('Active-target chrome matrix', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin')
    await expect(page.locator('[data-testid="active-target-indicator"]')).toBeVisible()
  })

  for (const row of matrix) {
    test(`${row.name} → chrome=${row.chromeClass} readOnly=${row.readOnly}`, async ({ page }) => {
      const indicator = page.locator('[data-testid="active-target-indicator"]')

      // Open the switcher and select the target under test. Every run
      // starts from whatever was active last; the menu always lists all
      // targets so this is stable regardless of order.
      await indicator.click()
      const menu = page.locator('[data-testid="active-target-menu"]')
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name: row.name, exact: true }).click()

      // Assert chrome class + indicator content.
      await expect(indicator).toContainText(row.name)
      await expect(indicator).toHaveClass(new RegExp(row.chromeClass))

      // Read-only badge: shown iff editable === false.
      const badge = indicator.locator('.readonly-badge')
      if (row.readOnly) {
        await expect(badge).toBeVisible()
        await expect(badge).toContainText('read-only')
      } else {
        await expect(badge).toHaveCount(0)
      }
    })
  }
})
