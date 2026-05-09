/**
 * Cut 15 — soft-delete archive scenario.
 *
 * Surfaces crossed: PageMetadataEditor + ArchiveModal + SiteTree (archive
 * filter toggle + greyed archived row) + ArchiveBanner (Restore action) +
 * archive store state machine. No feature test covers all five together.
 *
 * What regresses if this breaks:
 *   - Archive button on a live page → modal opens → confirm with empty
 *     alias → page disappears from live tree, appears under "Show archived"
 *   - Selecting an archived row → editor pane is read-only with banner
 *   - Banner's Restore button → page returns to the live tree
 *   - manifest's `archived: true` field round-trips through site-loader
 *
 * Per Cut 13 + 15 design notes: the e2e covers the happy-path UX flow that
 * exercises every UI surface shipped in cuts 5–13. Unit + integration tests
 * (99 tests across admin-api routes / archive-aliases sidecar / CLI / review
 * integration / archive-helpers) cover the underlying contracts. This file
 * verifies the cross-cutting browser flow nobody else does.
 */
import { test, expect } from '../fixtures'
import { resetScenarioState } from './_isolation'

test.describe('Scenario — archive a page, see it greyed in tree, restore', () => {
  test.beforeEach(async ({ testSite }) => {
    await resetScenarioState(testSite.projectDir)
  })

  test('happy path: archive → tree greying → restore → tree restoration', async ({ page }) => {
    // --- Open the about page's editor, scroll to PageMetadataEditor ---
    // (PageMetadataEditor only renders when path === '_root'; navigating
    // straight to /edit with no component selected achieves that.)
    await page.goto('/admin/pages/about/edit')

    // Wait for the metadata editor to render — that's our anchor for the
    // archive button.
    const archiveBtn = page.locator('[data-testid="page-archive-btn"]')
    await expect(archiveBtn).toBeVisible({ timeout: 10000 })

    // --- Click Archive → modal opens ---
    await archiveBtn.click()
    const modal = page.locator('[data-testid="archive-modal"]')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // --- Confirm archive with no alias (pure soft-delete) ---
    const confirmBtn = page.locator('[data-testid="archive-confirm"]')
    await confirmBtn.click()

    // Modal should close after the archive store completes.
    await expect(modal).not.toBeVisible({ timeout: 10000 })

    // --- Verify the page disappears from the live tree ---
    // The about page's tree row uses `site-page-about` per SiteTree.vue.
    // After archive, it should NOT be visible by default (showArchived: false).
    const aboutRow = page.locator('[data-testid="site-page-about"]')
    await expect(aboutRow).not.toBeVisible({ timeout: 10000 })

    // --- Toggle "Show archived" ---
    const archiveToggle = page.locator('[data-testid="archive-toggle-input"]')
    await expect(archiveToggle).toBeVisible({ timeout: 5000 })
    await archiveToggle.check()

    // The archived row should now appear (and be styled differently per
    // Cut 10 — but visibility is the locked behavior, styling is not part
    // of this test's scope).
    await expect(aboutRow).toBeVisible({ timeout: 5000 })

    // --- Select the archived page → editor shows ArchiveBanner ---
    await aboutRow.click()

    // Banner uses `archive-banner-{kind}-{name}` as its testid.
    const banner = page.locator('[data-testid="archive-banner-page-about"]')
    await expect(banner).toBeVisible({ timeout: 10000 })

    // --- Click Restore ---
    const restoreBtn = page.locator('[data-testid="archive-restore-page-about"]')
    await expect(restoreBtn).toBeVisible()
    await restoreBtn.click()

    // After restore: banner gone, page back in the live tree.
    await expect(banner).not.toBeVisible({ timeout: 10000 })

    // The about row should still be visible (we're still in showArchived
    // mode, but archived state cleared); toggle off and verify it's still
    // there in the live tree.
    await archiveToggle.uncheck()
    await expect(aboutRow).toBeVisible({ timeout: 5000 })
  })
})
