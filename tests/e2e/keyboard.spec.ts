import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

test.describe('Keyboard shortcuts', () => {
  test('Control+S saves a dirty form without clicking the save button', async ({ page }) => {
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 10000 })
    const original = await titleField.inputValue()
    await titleField.fill(original + ' — ctrl+s test')

    // Save button should be enabled (dirty form).
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()

    // Press Ctrl+S — the editor's onKeyStroke('s') handler checks
    // metaKey||ctrlKey and calls editing.save(). We use Control
    // because it works cross-platform in Playwright's key API.
    await page.keyboard.press('Control+s')

    // Saved state confirmed via toast + save-btn back to disabled.
    await expect(page.locator('[data-testid="global-toast"]')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled({ timeout: 5000 })
  })

  test('Meta+S (Cmd+S on Mac) saves a dirty form', async ({ page }) => {
    // Same handler path (metaKey||ctrlKey) — verifies the Mac-style
    // modifier is honored, not just the Linux/Windows Control.
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 10000 })
    const original = await titleField.inputValue()
    await titleField.fill(original + ' — cmd+s test')

    await page.keyboard.press('Meta+s')

    await expect(page.locator('[data-testid="global-toast"]')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled({ timeout: 5000 })
  })

  test('Control+S on a clean form is a no-op (does not trigger toast)', async ({ page }) => {
    // The handler guards with `if (editing.dirty)` — a save shortcut
    // on an unmodified form should not fire the save pipeline.
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    await page.locator('input[name="root_title"]').first().waitFor({ timeout: 10000 })

    // Form is clean at this point — save button should be disabled.
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()

    await page.keyboard.press('Control+s')

    // No toast should appear. Give it a moment, then confirm.
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="global-toast"]')).not.toBeVisible()
  })

  test('Control+Z undoes the last field edit (form-scoped history)', async ({ page }) => {
    // The default @rjsf editor (packages/gazetta/src/editor/mount.tsx:869-914)
    // maintains a 50-entry undo stack per form. Ctrl/Cmd+Z reverts the
    // most recent change without hitting the save pipeline.
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 10000 })
    const original = await titleField.inputValue()

    // Make two edits so there's real undo history.
    await titleField.fill(original + ' first edit')
    await titleField.blur()
    await titleField.fill(original + ' second edit')
    await titleField.blur()
    await expect(titleField).toHaveValue(original + ' second edit')

    // Undo last edit → field returns to "first edit" state.
    await page.keyboard.press('Control+z')
    await expect(titleField).toHaveValue(original + ' first edit', { timeout: 2000 })

    // Undo again → returns to the original.
    await page.keyboard.press('Control+z')
    await expect(titleField).toHaveValue(original, { timeout: 2000 })
  })

  test('Control+Shift+Z redoes an undone field edit', async ({ page }) => {
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 10000 })
    const original = await titleField.inputValue()

    await titleField.fill(original + ' edited')
    await titleField.blur()

    // Undo → back to original.
    await page.keyboard.press('Control+z')
    await expect(titleField).toHaveValue(original, { timeout: 2000 })

    // Redo → edited value restored.
    await page.keyboard.press('Control+Shift+z')
    await expect(titleField).toHaveValue(original + ' edited', { timeout: 2000 })
  })
})
