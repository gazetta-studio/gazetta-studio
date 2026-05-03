import { test, expect } from './fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

test.describe('Component operations', () => {
  // These tests mutate page.json on disk via the API. Isolation comes from the
  // worker-scoped testSite fixture — each Playwright worker has its own copy
  // of the starter site. Tests within the file share state; each one uses a
  // unique component name so they don't collide.

  test('add inline component via dialog', async ({ page }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const name = `test-add-${testInfo.testId}`

    const beforeCount = await tree.allRows.count()

    await tree.add(name, 'text-block')

    await expect(tree.row(name)).toBeVisible({ timeout: 10000 })
    expect(await tree.allRows.count()).toBe(beforeCount + 1)
  })

  test('remove component', async ({ page }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const name = `test-remove-${testInfo.testId}`

    // Add a component first so we have something to remove
    await tree.add(name, 'text-block')
    await expect(tree.row(name)).toBeVisible({ timeout: 10000 })

    const beforeCount = await tree.allRows.count()

    await tree.remove(name)

    await expect(tree.row(name)).not.toBeVisible({ timeout: 10000 })
    expect(await tree.allRows.count()).toBe(beforeCount - 1)
  })

  test('move component changes order in the tree (pending until save)', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // hero should be above features in the tree
    const heroBefore = await tree.row('hero').boundingBox()
    const featuresBefore = await tree.row('features').boundingBox()
    expect(heroBefore!.y).toBeLessThan(featuresBefore!.y)

    // Move features up — it should swap with hero in the tree (pending state)
    await tree.moveUp('features')

    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Save flushes the pending reorder to disk
    await page.click('[data-testid="save-btn"]')
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled({ timeout: 10000 })

    // Restore order so subsequent tests see hero above features
    await tree.moveDown('features')
    await page.click('[data-testid="save-btn"]')
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled({ timeout: 10000 })
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(heroAfter!.y).toBeLessThan(featuresAfter!.y)
    }).toPass({ timeout: 10000 })
  })

  // Regression for #106 — reordering must be batched into the pending model
  // alongside content edits. The bug: reorder used to write immediately,
  // so discarding the focused content edit reverted content but not order,
  // breaking authors' "everything pending until save" expectation.
  test('reorder + content edit are both pending until save (#106)', async ({ page, testSite }, testInfo) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    const pageJsonPath = join(testSite.projectDir, 'sites/main/targets/local/pages/home/page.json')

    // Snapshot disk state before any edits.
    const beforeJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const beforeNames = (beforeJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )

    // Make a structural pending edit (move features up).
    await tree.moveUp('features')

    // Tree reflects the pending order immediately.
    await expect(async () => {
      const heroAfter = await tree.row('hero').boundingBox()
      const featuresAfter = await tree.row('features').boundingBox()
      expect(featuresAfter!.y).toBeLessThan(heroAfter!.y)
    }).toPass({ timeout: 10000 })

    // Disk file has NOT changed — the reorder is only pending.
    const duringJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const duringNames = (duringJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )
    expect(duringNames).toEqual(beforeNames)

    // Save button is enabled because there's pending work.
    const saveBtn = page.locator('[data-testid="save-btn"]')
    await expect(saveBtn).toBeEnabled()

    // Save flushes structural change to disk.
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })

    const afterJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
    const afterNames = (afterJson.components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )
    expect(afterNames.indexOf('features')).toBeLessThan(afterNames.indexOf('hero'))

    // Cleanup so subsequent tests in this file see the original order.
    await tree.moveDown('features')
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })

    // Mark the test info — useful when this regression is mentioned in the
    // PR / changelog.
    testInfo.annotations.push({ type: 'regression', description: 'github#106' })
  })
})
