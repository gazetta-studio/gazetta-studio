/**
 * Page Object for the component tree panel in the editor.
 *
 * Wraps the `[data-testid="component-{name}"]` rows + their
 * hover-revealed actions (add / remove / move / revert) and the
 * add-component dialog. Tests describe user-level actions — `open`,
 * `add`, `remove`, `moveUp` — without fishing for testid strings.
 *
 * Conventions match PublishPanelPom + SiteTreePom:
 *   - `page` injected in the constructor; no inheritance
 *   - Methods = user actions; getters return locators; assertions stay
 *     in the tests
 *   - Composes class-based selectors (.node-dirty-dot, .node-revert)
 *     under the row's testid so stable internal markup doesn't leak
 *     into spec files
 */
import type { Locator, Page } from '@playwright/test'

export class ComponentTreePom {
  constructor(private readonly page: Page) {}

  // ---- Rows -----------------------------------------------------------

  /** Row for a component by name (e.g. 'hero', 'features'). */
  row(name: string): Locator {
    return this.page.locator(`[data-testid="component-${name}"]`)
  }

  /** Every component row — used for count assertions in add/remove tests. */
  get allRows(): Locator {
    return this.page.locator('[data-testid^="component-"]')
  }

  /** Click a component row to focus its editor. */
  async open(name: string): Promise<void> {
    await this.row(name).click()
  }

  // ---- Dirty + revert -------------------------------------------------

  /**
   * Dirty dot on a component row (pending-edit or in-flight save).
   * Composes `.node-dirty-dot` under the row's testid — the class is
   * internal markup but stable per ComponentTree.vue.
   */
  dirtyDot(name: string): Locator {
    return this.row(name).locator('.node-dirty-dot')
  }

  /**
   * Revert button on a component row — visible on hover when the row
   * has pending edits. Wraps the `.node-revert` class inside the
   * row's testid.
   */
  revertButton(name: string): Locator {
    return this.row(name).locator('.node-revert')
  }

  /** Hover then click revert. */
  async revert(name: string): Promise<void> {
    await this.row(name).hover()
    await this.revertButton(name).click()
  }

  // ---- Add / remove / move -------------------------------------------

  /**
   * Add an inline component: open dialog → fill name → pick template
   * → submit. `template` matches the listbox option text (e.g.
   * 'text-block', 'hero').
   */
  async add(name: string, template: string): Promise<void> {
    await this.page.click('[data-testid="add-component"]')
    const nameInput = this.page.locator('[data-testid="add-component-name"]')
    await nameInput.waitFor({ timeout: 5000 })
    await nameInput.fill(name)
    // PrimeVue Listbox — options don't carry testids; text match is the
    // only stable handle short of patching PrimeVue.
    await this.page.locator('.p-listbox-option', { hasText: template }).click()
    await this.page.click('[data-testid="add-component-submit"]')
  }

  /** Hover then click the per-row remove button. */
  async remove(name: string): Promise<void> {
    await this.row(name).hover()
    await this.page.click(`[data-testid="remove-${name}"]`)
  }

  /**
   * Hover then click the per-row Duplicate button (#45). The duplicate
   * lands at the source's index + 1 with name `${source}-copy[-N]`;
   * pending until save like every other structural change.
   */
  async duplicate(name: string): Promise<void> {
    await this.row(name).hover()
    await this.page.click(`[data-testid="duplicate-${name}"]`)
  }

  /**
   * Move a top-level row one position up. Uses the Alt+ArrowUp keyboard
   * shortcut (#105 — replaces the legacy move-up button); simulating a
   * pointer drag in Playwright is brittle across browsers and the
   * keyboard path exercises the same store action via a deterministic
   * code path.
   *
   * Wait-for-handle-stable before focus + key dispatch — after a save
   * cycle the v-for can rerender and Playwright's auto-wait won't
   * always catch the new handle node before `focus()` resolves
   * against a stale reference. Two-step locator resolution (waitFor
   * → focus) is the robust shape on CI cold-start.
   */
  async moveUp(name: string): Promise<void> {
    const handle = this.page.locator(`[data-testid="drag-handle-${name}"]`)
    await handle.waitFor({ state: 'visible', timeout: 10000 })
    await handle.focus()
    await this.page.keyboard.press('Alt+ArrowUp')
  }

  /** Move a top-level row one position down (Alt+ArrowDown shortcut). */
  async moveDown(name: string): Promise<void> {
    const handle = this.page.locator(`[data-testid="drag-handle-${name}"]`)
    await handle.waitFor({ state: 'visible', timeout: 10000 })
    await handle.focus()
    await this.page.keyboard.press('Alt+ArrowDown')
  }

  // ---- Dialog surfaces (for assertions about the add flow) ----------

  /** Name field in the add-component dialog. */
  get addDialogNameInput(): Locator {
    return this.page.locator('[data-testid="add-component-name"]')
  }

  /** Submit button in the add-component dialog. */
  get addDialogSubmit(): Locator {
    return this.page.locator('[data-testid="add-component-submit"]')
  }
}
