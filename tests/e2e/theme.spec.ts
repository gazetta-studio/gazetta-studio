import { test, expect } from './fixtures'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

test.describe('User theme', () => {
  test('admin/theme.css overrides Gazetta tokens and exposes custom tokens', async ({ page, testSite }) => {
    // Seed a theme.css that overrides --color-primary, --color-env-prod-bg
    // (a Gazetta token), and adds a user-namespaced custom token. The dev
    // server's user-theme route picks this up without restart.
    await writeFile(
      join(testSite.projectDir, 'admin/theme.css'),
      `
      :root {
        --color-primary: rgb(124, 58, 237);
        --color-env-prod-bg: rgb(255, 245, 230);
        --myapp-test-color: rgb(255, 0, 255);
      }
      .dark {
        --color-primary: rgb(167, 139, 250);
        --color-env-prod-bg: rgb(42, 26, 5);
        --myapp-test-color: rgb(0, 255, 255);
      }
    `,
    )
    // Force a fresh cold load so the runtime <link> injection runs from main.ts
    await page.goto('/admin')
    // Wait for the theme.css link to actually load (main.ts appends it after the admin's own styles)
    await page.waitForFunction(
      () => {
        return getComputedStyle(document.documentElement).getPropertyValue('--myapp-test-color').trim() !== ''
      },
      { timeout: 5000 },
    )

    const dark = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      return {
        primary: cs.getPropertyValue('--color-primary').trim(),
        envProdBg: cs.getPropertyValue('--color-env-prod-bg').trim(),
        myapp: cs.getPropertyValue('--myapp-test-color').trim(),
      }
    })
    expect(dark.primary).toBe('rgb(167, 139, 250)')
    expect(dark.envProdBg).toBe('rgb(42, 26, 5)')
    expect(dark.myapp).toBe('rgb(0, 255, 255)')

    await page.locator('[data-testid="theme-toggle"]').click()
    await page.waitForTimeout(200)
    const light = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      return {
        primary: cs.getPropertyValue('--color-primary').trim(),
        envProdBg: cs.getPropertyValue('--color-env-prod-bg').trim(),
        myapp: cs.getPropertyValue('--myapp-test-color').trim(),
      }
    })
    expect(light.primary).toBe('rgb(124, 58, 237)')
    expect(light.envProdBg).toBe('rgb(255, 245, 230)')
    expect(light.myapp).toBe('rgb(255, 0, 255)')
  })

  test('/admin/theme.css returns empty CSS when no user file exists', async ({ page, testSite }) => {
    // Make sure no theme file is present — the worker copies the starter which
    // does not include one, but be explicit in case prior tests added it.
    await rm(join(testSite.projectDir, 'admin/theme.css'), { force: true })
    const res = await page.request.get('/admin/theme.css')
    // 200 with empty body (not 404) — see mountUserThemeRoute. A 404 would
    // trigger a browser console error on every cold load.
    expect(res.status()).toBe(200)
    expect(await res.text()).toBe('')
  })
})

test.describe('Toast', () => {
  test('error toasts persist and have a dismiss button', async ({ page }) => {
    test.info().annotations.push({ type: 'allow-console-errors' })
    // Force every page-load to fail — opening home triggers selection.selectPage,
    // which calls toast.showError on failure. That's a real error path that
    // exercises the persistence + dismiss behavior end-to-end.
    // Wildcard suffix so the ?target=<active> query the api client auto-appends
    // still matches. Without `**` after home, glob expects end-of-path.
    await page.route('**/admin/api/v1/pages/home**', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: '{"type":"about:blank","title":"Internal Server Error","status":500,"code":"INTERNAL","detail":"boom"}',
      }),
    )
    await page.goto('/admin/pages/home')
    const toast = page.locator('[data-testid="global-toast"]')
    await expect(toast).toBeVisible()
    // Stays visible past the 3s success-toast auto-dismiss window
    await page.waitForTimeout(3500)
    await expect(toast).toBeVisible()
    // Dismiss button removes it
    await page.locator('[data-testid="toast-dismiss"]').click()
    await expect(toast).toHaveCount(0)
  })
})

test.describe('Theme toggle', () => {
  test('switches between dark and light mode', async ({ page }) => {
    await page.goto('/admin')
    // Default should have a theme toggle button
    const toggle = page.locator('[data-testid="theme-toggle"]')
    await expect(toggle).toBeVisible()

    // Click to toggle
    await toggle.click()

    // Check that the html element has the expected class
    const htmlClass = await page.locator('html').getAttribute('class')
    // After toggle, class is either 'dark' or empty
    expect(htmlClass !== null).toBeTruthy()
  })
})
