/**
 * Page Object for the unified Publish panel.
 *
 * Wraps the `[data-testid="publish-panel"]` surface so tests depend on
 * user-level actions ("open", "pick destination", "click publish")
 * instead of raw selectors. When a testid renames or the DOM shifts,
 * only this file changes.
 *
 * Conventions (per Playwright POM docs + team-preferences rule #3):
 * - Locators returned, no assertions — tests own `expect()`
 * - `page` injected in the constructor; no inheritance
 * - Method names match what the user does, not the DOM: `publish()`
 *   clicks the button; `publishWithProdConfirm()` handles the
 *   two-click dance for production targets.
 */
import type { Locator, Page } from '@playwright/test'

export class PublishPanelPom {
  constructor(private readonly page: Page) {}

  // ---- Opening ---------------------------------------------------------

  /** Open the panel from the toolbar button. Panel is not scoped to a
   *  selected item — it's a cross-target operation.
   *
   *  Awaits the /api/targets response triggered by the admin boot before
   *  clicking, so the activeTarget store is hydrated when the panel
   *  mounts. Without this, on slow CI shards (issue #268) the panel
   *  could render with `editableTargets=[]` and show
   *  '(no editable target)' until the API response landed — the
   *  resulting flake exhausted Playwright's 5s expect timeout 7/7 times
   *  observed via attempt-rerun analysis. waitForResponse uses its own
   *  30s default, comfortably above worst-case CI latency. */
  async open(): Promise<void> {
    const targetsReady = this.page.waitForResponse('**/admin/api/targets**')
    await this.page.goto('/admin')
    await targetsReady
    await this.page.locator('[data-testid="publish-btn"]').click()
  }

  /** Root of the panel — for visibility assertions at the top of tests. */
  get root(): Locator {
    return this.page.locator('[data-testid="publish-panel"]')
  }

  // ---- Source ----------------------------------------------------------

  /** Fixed source chip (shown when only one editable target exists). */
  get sourceFixed(): Locator {
    return this.page.locator('[data-testid="publish-source-fixed"]')
  }

  // ---- Destinations ----------------------------------------------------

  /** Destination row (single). */
  destination(name: string): Locator {
    return this.page.locator(`[data-testid="publish-dest-${name}"]`)
  }

  /** Group header row (e.g. `production` when 2+ prod targets exist). */
  destinationGroup(env: string): Locator {
    return this.page.locator(`[data-testid="publish-dest-group-${env}"]`)
  }

  /** Click a destination to toggle its selection. */
  async pickDestination(name: string): Promise<void> {
    await this.destination(name).click()
  }

  /** Click a group header — selects/deselects every member at once. */
  async toggleGroup(env: string): Promise<void> {
    await this.destinationGroup(env).click()
  }

  /** Whether a destination's row-level PrimeVue checkbox is checked. */
  isDestinationChecked(name: string): Locator {
    return this.page.locator(`[data-testid="publish-dest-${name}"] .p-checkbox-checked`)
  }

  // ---- Items -----------------------------------------------------------

  /** Item row by path (e.g. `pages/home`, `fragments/header`). */
  item(path: string): Locator {
    return this.page.locator(`[data-testid="publish-item-${path}"]`)
  }

  /** Summary line showing added/modified/deleted counts. */
  get itemsSummary(): Locator {
    return this.page.locator('[data-testid="publish-items-summary"]')
  }

  /** Inline compare-error block (shown when the compare API fails). */
  get itemsError(): Locator {
    return this.page.locator('[data-testid="publish-items-error"]')
  }

  /** Click Select-all above the items list. */
  async selectAllItems(): Promise<void> {
    await this.page.locator('[data-testid="publish-select-all"]').click()
  }

  /** Click Select-none above the items list. */
  async selectNoItems(): Promise<void> {
    await this.page.locator('[data-testid="publish-select-none"]').click()
  }

  // ---- Action buttons --------------------------------------------------

  /** The main Publish button (enabled when source + destinations + items
   *  are all set). Non-prod destinations: one click runs the publish.
   *  Prod destinations: first click reveals the confirm banner. */
  get publishButton(): Locator {
    return this.page.locator('[data-testid="publish-panel-confirm"]')
  }

  /** The danger-styled second-click button that appears only after a
   *  production destination triggers the confirm flow. */
  get publishProdConfirmButton(): Locator {
    return this.page.locator('[data-testid="publish-panel-confirm-prod"]')
  }

  /** The Done button that replaces Publish/Cancel after a successful run. */
  get doneButton(): Locator {
    return this.page.locator('[data-testid="publish-panel-done"]')
  }

  /** Click Publish (single-click). For non-prod destinations only. */
  async publish(): Promise<void> {
    await this.publishButton.click()
  }

  /** Click Publish, then the prod-specific second-click confirm. */
  async publishWithProdConfirm(): Promise<void> {
    await this.publishButton.click()
    await this.publishProdConfirmButton.click()
  }

  /** Back button (appears only in the confirm-banner state). */
  async clickBack(): Promise<void> {
    await this.page.locator('button', { hasText: 'Back' }).click()
  }

  // ---- Status surfaces -------------------------------------------------

  /** Production confirmation banner. */
  get confirmBanner(): Locator {
    return this.page.locator('[data-testid="publish-confirm-banner"]')
  }

  /** Invalid-templates fatal banner (rendered on SSE fatal event). */
  get invalidTemplatesBanner(): Locator {
    return this.page.locator('[data-testid="publish-invalid-templates"]')
  }

  /** Streaming-progress block — visible between publish-start and publish-done. */
  get progressBlock(): Locator {
    return this.page.locator('[data-testid="publish-progress"]')
  }

  /** Per-destination result row (success or error). */
  result(target: string): Locator {
    return this.page.locator(`[data-testid="publish-result-${target}"]`)
  }
}
