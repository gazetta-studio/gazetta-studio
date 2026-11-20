import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { openEditor, expectSaveSettled } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * The Markdown field (`format.markdown()`, design-content-trust.md Q7, Q8)
 * end to end: a Tiptap editor that saves Markdown, a Formatted/Markdown
 * toggle remembered across reloads, a field nobody edited saved unchanged,
 * and the preview showing the Markdown rendered and sanitized.
 *
 * Uses the starter's `blog/[slug]` page, whose `article` component has a
 * Markdown `body` field.
 */
const pageJsonPath = (projectDir: string) => join(projectDir, 'sites/main/targets/local/pages/blog/[slug]/page.json')

const articleBody = (projectDir: string): string => {
  const saved = JSON.parse(readFileSync(pageJsonPath(projectDir), 'utf8'))
  return saved.components.find((c: { name?: string }) => c.name === 'article').content.body
}

async function openArticle(page: Page) {
  await openEditor(page, encodeURIComponent('blog/[slug]'))
  await new ComponentTreePom(page).open('article')
  const editor = page.locator('[data-testid="markdown-editor"]')
  await expect(editor).toBeVisible({ timeout: 20000 })
  return editor
}

test.describe('Markdown field', () => {
  // The worker's site copy is shared with other spec files: put the page
  // back as this test found it.
  let original: string | undefined
  test.beforeEach(({ testSite }) => {
    original = readFileSync(pageJsonPath(testSite.projectDir), 'utf8')
  })
  test.afterEach(async ({ page, testSite }) => {
    if (original !== undefined) writeFileSync(pageJsonPath(testSite.projectDir), original)
    await page.evaluate(() => localStorage.removeItem('gazetta:markdown-view')).catch(() => {})
  })

  test('edits in both views are saved as Markdown and previewed sanitized', async ({ page, testSite }) => {
    test.setTimeout(60_000)
    const editor = await openArticle(page)
    await expect(editor.locator('[data-testid="markdown-mode-formatted"]')).toHaveAttribute('aria-pressed', 'true')

    // Formatted view: a new paragraph with a bold run from the toolbar.
    const prose = editor.locator('.tiptap')
    await prose.evaluate(el => {
      ;(el as HTMLElement & { editor: { commands: { focus(pos: 'end'): boolean } } }).editor.commands.focus('end')
    })
    await expect(prose).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.type('Plain then ')
    await editor.locator('[data-testid="markdown-bold"]').click()
    await page.keyboard.type('strong words')
    await expect(prose.locator('strong', { hasText: 'strong words' })).toBeVisible()

    // Markdown view: the bold run is Markdown; append raw Markdown with a script.
    await editor.locator('[data-testid="markdown-mode-markdown"]').click()
    await expect(editor.locator('[data-testid="markdown-mode-note"]')).toHaveText(
      'Formatted view may reformat Markdown.',
    )
    const source = editor.locator('[data-testid="markdown-source"]')
    await expect(source).toHaveValue(/Plain then \*\*strong words\*\*/)
    await source.focus()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('\n\n<script>window.__mdXss = 1</script>\n\nTyped in *markdown*')

    const preview = page.frameLocator('[data-testid="preview-iframe"]')
    await expect(preview.locator('em', { hasText: 'markdown' })).toBeVisible({ timeout: 15000 })
    await expect(preview.locator('strong', { hasText: 'strong words' })).toBeVisible()
    await expect(preview.locator('script', { hasText: '__mdXss' })).toHaveCount(0)

    const saveBtn = page.locator('[data-testid="save-btn"]')
    await saveBtn.click()
    await expectSaveSettled(saveBtn, { timeout: 10000 })

    const body = articleBody(testSite.projectDir)
    expect(body).toContain('Plain then **strong words**')
    expect(body).toContain('Typed in *markdown*')
    expect(body).not.toContain('<strong>')

    // The chosen view survives a reload.
    await page.reload()
    const reloaded = await openArticle(page)
    await expect(reloaded.locator('[data-testid="markdown-mode-markdown"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(reloaded.locator('[data-testid="markdown-source"]')).toHaveValue(body)
  })

  test('a Markdown field nobody edited is saved byte-identical', async ({ page, testSite }) => {
    test.setTimeout(60_000)
    const before = articleBody(testSite.projectDir)
    const editor = await openArticle(page)
    await editor.locator('[data-testid="markdown-mode-markdown"]').click()
    await editor.locator('[data-testid="markdown-mode-formatted"]').click()

    // Save the page through another edit: its SEO title.
    await new ComponentTreePom(page).open('blog/[slug]')
    const title = page.locator('[data-testid="meta-title"]')
    await title.waitFor({ timeout: 20000 })
    await title.fill('Untouched body test')
    const saveBtn = page.locator('[data-testid="save-btn"]')
    await saveBtn.click()
    await expectSaveSettled(saveBtn, { timeout: 10000 })

    const saved = JSON.parse(readFileSync(pageJsonPath(testSite.projectDir), 'utf8'))
    expect(saved.metadata.title).toBe('Untouched body test')
    expect(articleBody(testSite.projectDir)).toBe(before)
  })

  test('the toggle and the toolbar work from the keyboard', async ({ page }) => {
    const editor = await openArticle(page)
    const formatted = editor.locator('[data-testid="markdown-mode-formatted"]')
    const markdown = editor.locator('[data-testid="markdown-mode-markdown"]')
    await formatted.focus()
    await page.keyboard.press('Tab')
    await expect(markdown).toBeFocused()
    await page.keyboard.press('Space')
    await expect(markdown).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect(formatted).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(formatted).toHaveAttribute('aria-pressed', 'true')

    // Tab from the toggle reaches the toolbar; Enter applies its formatting.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const bold = editor.locator('[data-testid="markdown-bold"]')
    await expect(bold).toBeFocused()
    await editor.locator('.tiptap').evaluate(el => {
      ;(el as HTMLElement & { editor: { commands: { selectAll(): boolean } } }).editor.commands.selectAll()
    })
    await bold.focus()
    await page.keyboard.press('Enter')
    await expect(bold).toHaveAttribute('aria-pressed', 'true')
  })
})
