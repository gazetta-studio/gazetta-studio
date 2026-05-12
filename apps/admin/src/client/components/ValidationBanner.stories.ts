/**
 * Stories for ValidationBanner — Pinia-store-driven component.
 *
 * Validates the **Pinia store seeding pattern** for stories:
 *
 *   1. Storybook's preview.ts installs a fresh Pinia instance via
 *      `app.use(createPinia())` once per preview boot.
 *   2. Each story uses a Vue decorator to grab the validation-issues
 *      store inside `setup()` (after Pinia is installed) and seeds
 *      it before the component mounts.
 *   3. The component reads from the seeded store; no prop wiring
 *      required — Krug "absence-as-state" works (banner hides
 *      automatically when issues list is empty).
 *
 * Future stories that depend on stores follow the same shape — call
 * the store inside `setup()`, mutate its state, return the component.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ValidationBanner from './ValidationBanner.vue'
import { useValidationIssuesStore } from '../stores/validationIssues.js'
import type { ValidationIssue } from '../api/client.js'

/**
 * Decorator factory — installs the validation-issues store in the
 * story's setup with the provided seed values.
 *
 * Each story call gets a fresh Pinia state because the decorator
 * runs setup before each story renders, and Storybook's preview.ts
 * uses the same Pinia instance for the entire preview boot. To
 * isolate tests at v1, we explicitly call `.clear()` then `.set()` —
 * if cross-story state leakage shows up at scale, the next step is
 * to wire `createTestingPinia` per story (see STORYBOOK.md).
 */
function seedIssues(issues: readonly ValidationIssue[]) {
  return () => ({
    components: { ValidationBanner },
    setup() {
      const validation = useValidationIssuesStore()
      validation.clear()
      validation.set(issues)
    },
    template: '<ValidationBanner />',
  })
}

const meta: Meta<typeof ValidationBanner> = {
  title: 'Validation / Banner',
  component: ValidationBanner,
}

export default meta

type Story = StoryObj<typeof ValidationBanner>

/**
 * Empty state — no issues, banner hidden. Krug "absence-as-state":
 * the rendered output is intentionally empty. Confirms the component
 * doesn't paint when there's nothing to say.
 */
export const NoIssues: Story = {
  render: seedIssues([]),
}

/**
 * Single error — the most common shape after a save fails one
 * ref-existence check (Cut 1 validators). Headline reads "1
 * validation error blocked the save".
 */
export const SingleError: Story = {
  render: seedIssues([
    {
      validator: 'referenced-asset-exists',
      severity: 'error',
      message: 'Referenced asset "hero" does not exist.',
      itemPath: 'pages/home/page.json',
      contentPath: 'hero',
    },
  ]),
}

/**
 * Multiple errors — exercises the headline pluralization ("N errors")
 * and the per-row severity icon rendering.
 */
export const MultipleErrors: Story = {
  render: seedIssues([
    {
      validator: 'referenced-asset-exists',
      severity: 'error',
      message: 'Referenced asset "hero" does not exist.',
      itemPath: 'pages/home/page.json',
      contentPath: 'hero',
    },
    {
      validator: 'referenced-fragment-exists',
      severity: 'error',
      message: 'Referenced fragment "@nav" does not exist.',
      itemPath: 'pages/home/page.json',
      contentPath: 'components.1',
    },
    {
      validator: 'circular-fragment-introduced',
      severity: 'error',
      message: 'Circular fragment reference: @header → @footer → @header',
      itemPath: 'fragments/header/fragment.json',
    },
  ]),
}

/**
 * Mixed severities — errors plus a non-blocking warn. The headline
 * counts the errors; the warn appears as "+1 non-blocking" aside.
 */
export const MixedSeverities: Story = {
  render: seedIssues([
    {
      validator: 'referenced-asset-exists',
      severity: 'error',
      message: 'Referenced asset "missing-image" does not exist.',
      itemPath: 'pages/about/page.json',
      contentPath: 'illustration',
    },
    {
      validator: 'schema-conformance',
      severity: 'warn',
      message: 'Optional field "description" is not set; recommended for SEO.',
      itemPath: 'pages/about/page.json',
      contentPath: 'metadata.description',
    },
  ]),
}

/**
 * Warnings only — no errors, save would have gone through. The
 * banner still renders to surface the warnings.
 */
export const WarningsOnly: Story = {
  render: seedIssues([
    {
      validator: 'schema-conformance',
      severity: 'warn',
      message: 'Field "ogImage" is missing; default thumbnail will be used.',
      itemPath: 'pages/home/page.json',
      contentPath: 'metadata.ogImage',
    },
  ]),
}
