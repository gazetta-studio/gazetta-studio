import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { PublishPanelPom } from './pages/PublishPanel'
import { SiteTreePom } from './pages/SiteTree'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rmSafe } from './_helpers/rm-safe.js'

test.describe('Publish panel', () => {
  // Staging target's storage path is ./dist/staging relative to sites/main
  function stagingDir(projectDir: string) {
    return join(projectDir, 'sites/main/dist/staging')
  }
  async function seedSidecar(dir: string, hash: string) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `.${hash}.hash`), '')
  }
  async function wipe(projectDir: string) {
    await rmSafe(stagingDir(projectDir))
  }

  test('opens with local as source and destinations listed', async ({ page, testSite: _ }) => {
    const panel = new PublishPanelPom(page)
    await panel.open()
    await expect(panel.root).toBeVisible()
    // Single editable target in starter (local) — source renders as a fixed chip
    await expect(panel.sourceFixed).toContainText('local')
    // Every non-source target appears as a destination row
    await expect(panel.destination('staging')).toBeVisible()
    await expect(panel.destination('esi-test')).toBeVisible()
    await expect(panel.destination('production')).toBeVisible()
  })

  test('PublishPanelPom.open() awaits /api/targets hydration before resolving (regression: #268)', async ({
    page,
    testSite: _,
  }) => {
    // Issue #268: on shard 5 under dev-server rebuild pressure the targets
    // API can take longer than Playwright's 5s expect timeout to respond.
    // If open() returns before targets are hydrated, editableTargets is []
    // and the source chip renders '(no editable target)' instead of 'local'.
    //
    // This test simulates the slow CI shard by delaying /api/targets so
    // the race is deterministic. The assertion uses a one-shot
    // textContent() read (no auto-retry) so the race is captured at the
    // moment open() resolves — without the fix, the chip is still in its
    // pre-hydration state; with the fix, open() has awaited the response
    // and the chip already reads 'local'.
    await page.route('**/admin/api/targets**', async route => {
      await new Promise(r => setTimeout(r, 6000))
      await route.continue()
    })

    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.sourceFixed.waitFor({ state: 'attached', timeout: 3000 })
    const text = (await panel.sourceFixed.textContent())?.trim() ?? ''
    expect(text).not.toContain('no editable target')
    expect(text).toContain('local')
  })

  test('first-publish destination shows all items as added', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    // Every local page becomes an 'added' row against the empty staging target
    const homeRow = panel.item('pages/home')
    await expect(homeRow).toBeVisible()
    await expect(homeRow.locator('.marker-added')).toHaveText('+')
  })

  test('modified item shows modified marker and state chip', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    // Seed a stale sidecar for pages/home so compare reports 'modified' there,
    // and a sidecar for pages/about so the target isn't empty (avoids every
    // page being classified 'added' via firstPublish).
    await seedSidecar(join(stagingDir(testSite.projectDir), 'pages/home'), '00000000')
    await seedSidecar(join(stagingDir(testSite.projectDir), 'pages/about'), 'aaaaaaaa')

    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    const row = panel.item('pages/home')
    await expect(row).toBeVisible()
    await expect(row.locator('.marker-modified')).toHaveText('●')
    await expect(row.locator('.dest-state-modified')).toContainText('modified')
  })

  test('deleted item renders informational (no checkbox, struck through)', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    // Seed a sidecar for a page that doesn't exist locally — it exists on
    // staging but not on the source, so compare classifies it 'deleted'.
    await seedSidecar(join(stagingDir(testSite.projectDir), 'pages/old-contact'), '11111111')

    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    const deletedRow = panel.item('pages/old-contact')
    await expect(deletedRow).toBeVisible()
    await expect(deletedRow).toHaveClass(/item-deleted/)
    // Deleted rows get a spacer instead of a checkbox
    await expect(deletedRow.locator('.deleted-spacer')).toHaveCount(1)
    await expect(deletedRow.locator('.p-checkbox')).toHaveCount(0)
    await expect(deletedRow.locator('.marker-deleted')).toHaveText('−')
  })

  test('summary line shows category counts', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    await seedSidecar(join(stagingDir(testSite.projectDir), 'pages/home'), '00000000')
    await seedSidecar(join(stagingDir(testSite.projectDir), 'pages/old-contact'), '11111111')
    // Other local pages (about/blog/showcase/404) become 'added' rows.

    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    await expect(panel.itemsSummary).toBeVisible()
    await expect(panel.itemsSummary).toContainText('modified')
    await expect(panel.itemsSummary).toContainText('added')
    await expect(panel.itemsSummary).toContainText('deleted')
  })

  test('fragment row shows blast-radius badge', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    // esi-test is the dynamic target — fragments appear as first-publish
    // items there. Wipe first so we get a clean fan-out.
    const esiDir = join(testSite.projectDir, 'sites/main/dist/esi-test')
    await rmSafe(esiDir)

    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('esi-test')
    const headerRow = panel.item('fragments/header')
    await expect(headerRow).toBeVisible()
    // Fragment rows mount a FragmentBlastRadius component (pulled in via
    // api.getDependents) — the badge shows the count of pages that reference it.
    await expect(headerRow.locator('[data-testid="fragment-blast-radius"]')).toBeVisible({ timeout: 5000 })
  })

  test('compare failure surfaces an inline error', async ({ page, testSite: _ }) => {
    test.info().annotations.push({ type: 'allow-console-errors' })
    // Intercept the compare call and force a 500. The item-list composable
    // reports the error via its own state.
    await page.route('**/admin/api/compare*', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Storage unreachable' }),
      }),
    )
    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    await expect(panel.itemsError).toBeVisible()
    await expect(panel.itemsError).toContainText('Storage unreachable')
  })

  test('production destination requires confirmation before publishing', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    // Fixture swaps the azure-blob production target for a filesystem one
    // with environment:production so this test doesn't need Azurite.
    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('production')
    // First click on Publish reveals the confirmation banner; the button
    // changes to a danger-styled "Yes, publish to production" variant.
    await panel.publish()
    await expect(panel.confirmBanner).toBeVisible()
    await expect(panel.publishProdConfirmButton).toBeVisible()
    await panel.clickBack()
    await expect(panel.confirmBanner).toHaveCount(0)
  })

  test('non-production destination publishes without confirmation', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    // Staging has environment:staging — no confirmation gate.
    // Clicking Publish goes straight to the streaming action.
    await panel.publish()
    await expect(panel.confirmBanner).toHaveCount(0)
    // Wait for completion — the Done button replaces Cancel/Publish on success.
    await expect(panel.doneButton).toBeVisible({ timeout: 10000 })
  })

  test('publish streams per-destination progress and lands on results', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    await panel.publish()
    // Either we catch the progress block mid-stream, or the publish is fast
    // enough to land straight on results — both are valid. What matters is
    // the per-destination result row.
    await Promise.race([
      panel.progressBlock.waitFor({ timeout: 2000 }).catch(() => null),
      panel.result('staging').waitFor({ timeout: 5000 }),
    ])
    await expect(panel.result('staging')).toBeVisible({ timeout: 10000 })
    await expect(panel.result('staging')).toHaveClass(/success/)
  })

  test('invalid templates surface as fatal error on publish', async ({ page, testSite }) => {
    test.info().annotations.push({ type: 'allow-console-errors' })
    await wipe(testSite.projectDir)
    // Break the 'hero' template — not parseable ts. The server emits a
    // 'fatal' SSE event with invalidTemplates, which the panel renders in
    // the error block. Restore afterward because the testSite fixture is
    // worker-scoped — a corrupted hero template would cascade into every
    // later test that renders the home page.
    const { readFile } = await import('node:fs/promises')
    const tpl = join(testSite.projectDir, 'templates/hero/index.ts')
    const orig = await readFile(tpl, 'utf-8')
    await writeFile(tpl, 'this is not valid ts!!!')
    try {
      const panel = new PublishPanelPom(page)
      await panel.open()
      await panel.pickDestination('staging')
      await panel.publish()
      await expect(panel.invalidTemplatesBanner).toBeVisible({ timeout: 10000 })
      await expect(panel.invalidTemplatesBanner).toContainText('hero')
    } finally {
      await writeFile(tpl, orig)
    }
  })

  test('works in light mode', async ({ page, testSite }) => {
    // Seed localStorage before any page navigation so theme.init() reads
    // 'light' on first paint. addInitScript runs on every fresh page context
    // — including the SSE-driven /__reload that wipe() triggers — so the
    // previous click-after-reload race (#332, recurring through #290 / #326)
    // can't happen: there's no click, and the init script runs before
    // theme.init() on every reload.
    await page.addInitScript(() => {
      localStorage.setItem('gazetta_theme', 'light')
    })
    await wipe(testSite.projectDir)
    await page.goto('/admin')
    const html = page.locator('html')
    await expect(html).toHaveClass(/light/)
    const panel = new PublishPanelPom(page)
    await page.locator('[data-testid="publish-btn"]').click()
    await expect(panel.root).toBeVisible()
    await panel.pickDestination('staging')
    await expect(panel.item('pages/home')).toBeVisible()
    await expect(html).not.toHaveClass(/dark/)
  })

  test('environment group header selects all members in the group', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    const panel = new PublishPanelPom(page)
    await panel.open()
    // Starter has two staging-env targets: staging + esi-test. The group
    // header appears when a group has 2+ members; single-member groups
    // (local when source, production) render flat.
    await expect(panel.destinationGroup('staging')).toBeVisible()
    // Neither member selected initially → clicking the header selects both.
    // PrimeVue Checkbox exposes state via the .p-checkbox-checked class on
    // the wrapper rather than the native `checked` attribute.
    await panel.toggleGroup('staging')
    await expect(panel.isDestinationChecked('staging')).toHaveCount(1)
    await expect(panel.isDestinationChecked('esi-test')).toHaveCount(1)
    // Clicking again deselects both.
    await panel.toggleGroup('staging')
    await expect(panel.isDestinationChecked('staging')).toHaveCount(0)
    await expect(panel.isDestinationChecked('esi-test')).toHaveCount(0)
  })

  test('select-all and select-none toggle every selectable item', async ({ page, testSite }) => {
    await wipe(testSite.projectDir)
    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    // Starts with every item checked (default). Click Select none → Publish
    // should become disabled (no items selected).
    await panel.selectNoItems()
    await expect(panel.publishButton).toBeDisabled()
    await panel.selectAllItems()
    await expect(panel.publishButton).toBeEnabled()
  })
})

test.describe('Fragment blast radius', () => {
  test('tree row shows compact blast-radius badge with page count', async ({ page }) => {
    // On a fresh dev server, multiple tree badges mount in parallel and
    // all hit /api/dependents before any sidecar has been written. The
    // admin-api's sidecar writer memoizes the backfill, so concurrent
    // callers share one in-flight pass — without that, they'd race to
    // an empty index and the badge would render count=0. This test
    // covers both the UI layer and that invariant.
    await page.goto('/admin')
    const tree = new SiteTreePom(page)
    const row = tree.fragmentRow('header')
    await row.waitFor({ timeout: 10000 })
    const badge = row.locator('[data-testid="fragment-blast-radius"]')
    await badge.waitFor({ timeout: 5000 })
    // Compact form — just the count, not the "used on N pages" text.
    // Starter has 6 pages all referencing @header (404, about, asset-demo,
    // blog/[slug], home, showcase).
    await expect(badge).toHaveText('6')
    // Hover title lists the dependent pages.
    await expect(badge).toHaveAttribute('title', /Used on:.*home/)
  })
})

test.describe('Save button labeling', () => {
  test('generic "Save" label for local (non-production) active target', async ({ page }) => {
    await openEditor(page, 'home')
    const save = page.locator('[data-testid="save-btn"]')
    await expect(save).toHaveText(/^\s*Save\s*$/)
    // Primary severity — PrimeVue adds no class for p-button-primary, so
    // assert the button is NOT the danger variant.
    await expect(save).not.toHaveClass(/p-button-danger/)
  })
})

test.describe('Sync indicator grouping', () => {
  test('collapses 2+ members of an environment into a group chip at 4+ targets', async ({ page }) => {
    // Starter has 4 targets; staging and esi-test both env=staging.
    // That triggers grouping (threshold = 4) and collapses the two
    // staging targets into a single expandable group chip.
    await page.goto('/admin')
    const group = page.locator('[data-testid="sync-chip-group-staging"]')
    await expect(group).toBeVisible()
    await expect(group).toContainText('staging')
    await expect(group).toContainText('(2)')
    // Individual member chips are hidden until the group expands.
    await expect(page.locator('[data-testid="sync-chip-staging"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="sync-chip-esi-test"]')).toHaveCount(0)
    // Click to expand — both member chips appear.
    await group.click()
    await expect(page.locator('[data-testid="sync-chip-staging"]')).toBeVisible()
    await expect(page.locator('[data-testid="sync-chip-esi-test"]')).toBeVisible()
    // Single-member groups (production) and the active target's
    // non-group (local when active) don't get a group chip.
    await expect(page.locator('[data-testid="sync-chip-group-production"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="sync-chip-production"]')).toBeVisible()
  })
})
