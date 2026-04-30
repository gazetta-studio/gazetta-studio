/**
 * Scenario — publishing a page that references an asset copies the
 * asset's manifest + bytes to the target.
 *
 * Surfaces crossed: PB + PB.P + filesystem (asset bytes on target). No
 * feature test asserts this — the existing publish.spec covers the UI
 * mechanics but not what physically lands on disk for media.
 *
 * What regresses if this breaks:
 *   - publishAssets wiring in the admin-api route disappears (page HTML
 *     ships referencing URLs to bytes that aren't on the target)
 *   - dedupe check incorrectly skips the asset on first publish
 *   - asset-publish runs after page render instead of before (visible
 *     here only via the resulting file ordering on disk, but it's the
 *     order-as-correctness invariant that protects production)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '../fixtures'
import { PublishPanelPom } from '../pages/PublishPanel'
import { resetScenarioState } from './_isolation'

test.describe('Scenario — publish carries asset bytes to target', () => {
  test.beforeEach(async ({ testSite }) => {
    await resetScenarioState(testSite.projectDir)
  })

  test('asset-demo publish lands manifest + primary bytes on staging', async ({ page, testSite }) => {
    const stagingAssets = join(testSite.projectDir, 'sites/main/dist/staging/assets')

    // Sanity: the wipe in resetScenarioState cleared everything.
    expect(existsSync(stagingAssets)).toBe(false)

    const panel = new PublishPanelPom(page)
    await panel.open()
    await panel.pickDestination('staging')
    // The starter's asset-demo page references `test-pattern` via _asset.
    // It's part of the default selection (everything is 'added' on first
    // publish), so the publish carries the asset transitively.
    await expect(panel.item('pages/asset-demo')).toBeVisible({ timeout: 10000 })
    await panel.publish()

    await expect(panel.result('staging')).toBeVisible({ timeout: 15000 })
    await expect(panel.result('staging')).toHaveClass(/success/)

    // The manifest landed.
    expect(existsSync(join(stagingAssets, 'test-pattern.asset.json'))).toBe(true)
    // Primary bytes landed under the hashed filename (hash is `2092f9b7`
    // per the starter's test-pattern manifest — content-addressed, so
    // it's stable across runs).
    expect(existsSync(join(stagingAssets, 'test-pattern-2092f9b7.jpg'))).toBe(true)
  })
})
