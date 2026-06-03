import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'
import { join } from 'node:path'
import { rmSafe } from './_helpers/rm-safe.js'

test.describe('Undo last save', () => {
  test('save toast offers Undo; clicking it reverts the content', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    await tree.open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 5000 })
    const original = await titleField.inputValue()
    await titleField.fill(original + ' — undo me')
    // Save.
    await page.locator('[data-testid="save-btn"]').click()
    // Toast appears with an Undo action button.
    const toast = page.locator('[data-testid="global-toast"]')
    await expect(toast).toBeVisible()
    const undo = page.locator('[data-testid="toast-action"]', { hasText: /Undo/i })
    await expect(undo).toBeVisible()
    await undo.click()
    // Wait for the "Undone" confirmation toast — fires after the
    // history/undo round-trip + site + selection reload + editor
    // re-mount all settle. At that point the form must show the
    // pre-save value again.
    await expect(page.locator('[data-testid="global-toast"]')).toContainText('Undone', { timeout: 10000 })
    // Re-locate the field — the editor was remounted, so the old
    // Playwright locator may point to a detached node.
    const restoredField = page.locator('input[name="root_title"]').first()
    await expect(restoredField).toHaveValue(original, { timeout: 5000 })
  })
})

test.describe('History panel', () => {
  test('switcher menu opens history panel; Restore reverts content', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    // Open the hero component and edit its title. The test is
    // count-agnostic — earlier tests in the same worker may have
    // produced revisions, so we don't assert an exact row count.
    await tree.open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 5000 })
    const original = await titleField.inputValue()
    await titleField.fill(original + ' — panel edit')
    await page.locator('[data-testid="save-btn"]').click()
    // Wait for save toast to confirm the save landed.
    await expect(page.locator('[data-testid="global-toast"]')).toContainText('Saved', { timeout: 5000 })
    // Toast is a transient success — 3s auto-dismiss. Wait for it to
    // clear before opening the menu so it can't visually interfere.
    await page.waitForTimeout(500)

    // Open the target switcher → click "View history".
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page
      .locator('[data-testid="active-target-menu"]')
      .getByRole('menuitem', { name: /view history/i })
      .click()
    const panel = page.locator('[data-testid="history-panel"]')
    await expect(panel).toBeVisible()
    const rows = panel.locator('[data-testid^="history-row-"]')
    // At minimum there's baseline + the save we just did.
    await expect(rows.first()).toBeVisible()
    const headRow = rows.first()
    await expect(headRow).toContainText('current')

    // Restore the baseline (oldest row) — that always predates
    // whatever earlier tests produced and is the safe "back to
    // original" target. Use `.last()` since rows are newest-first.
    const baselineRow = rows.last()
    await expect(baselineRow).toContainText('Initial baseline')
    await baselineRow.locator('button', { hasText: 'Restore' }).click()

    // Toast confirms; close panel and verify content reverted.
    await expect(page.locator('[data-testid="global-toast"]')).toContainText(/Restored/i, { timeout: 10000 })
    await page.locator('[data-testid="history-panel-close"]').click()
    const restoredField = page.locator('input[name="root_title"]').first()
    await expect(restoredField).toHaveValue(original, { timeout: 5000 })
  })

  test('history panel shows "no revisions" on a target with no history', async ({ page, testSite }) => {
    // Staging exists but hasn't been published to — no .gazetta/history/.
    // Need to wipe first in case earlier tests published.
    await rmSafe(join(testSite.projectDir, 'sites/main/dist/staging/.gazetta'))
    await page.goto('/admin')
    // Switch to staging via the top-bar menu.
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('staging')
    // Open history.
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page
      .locator('[data-testid="active-target-menu"]')
      .getByRole('menuitem', { name: /view history/i })
      .click()
    await expect(page.locator('[data-testid="history-empty"]')).toBeVisible()
  })
})
