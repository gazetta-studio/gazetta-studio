/**
 * Stories for ArchiveBanner — multi-store seeding pattern.
 *
 * ArchiveBanner reads from BOTH `useSiteStore` (page/fragment
 * summaries — to discover archived state by name) AND `useArchiveStore`
 * (in-flight loading state for the Restore button). Stories seed both
 * inside `setup()` to demonstrate the pattern for components that
 * compose multiple stores.
 *
 * Krug "absence-as-state": the banner renders nothing when the item is
 * live. The `Live` story confirms that contract by exercising the
 * no-paint path; the other stories exercise the archived variants
 * (pure soft-delete vs. aliased redirect).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ArchiveBanner from './ArchiveBanner.vue'
import { useSiteStore } from '../stores/site.js'
import type { PageSummary } from '../api/client.js'

/**
 * Decorator factory — seeds the site store's `pages` array with the
 * single page that the banner will look up by name.
 */
function seedSitePages(pages: readonly PageSummary[]) {
  return () => ({
    components: { ArchiveBanner },
    setup() {
      const site = useSiteStore()
      site.pages = [...pages]
      site.fragments = []
      return { kind: 'page' as const, name: pages[0]?.name ?? 'unknown' }
    },
    template: '<ArchiveBanner :kind="kind" :name="name" />',
  })
}

const meta: Meta<typeof ArchiveBanner> = {
  title: 'Archive / ArchiveBanner',
  component: ArchiveBanner,
}

export default meta

type Story = StoryObj<typeof ArchiveBanner>

/**
 * Live page — banner renders nothing. Krug "absence-as-state" pattern:
 * the rendered DOM is empty by design. Storybook still shows the story
 * in the sidebar; selecting it confirms the absence of a banner is the
 * intended UX for the live state (no "this page is live" notice).
 */
export const Live: Story = {
  render: seedSitePages([{ name: 'home', route: '/', template: 'page-default' }]),
}

/**
 * Archived without alias — pure soft-delete. Banner shows:
 *   "Archived. Pure soft-delete — old URL returns 410 Gone."
 * Plus actions: Restore, Edit alias, Delete permanently.
 */
export const ArchivedPureSoftDelete: Story = {
  render: seedSitePages([
    {
      name: 'old-promo',
      route: '/promotions/spring-2024',
      template: 'page-default',
      archived: true,
    },
  ]),
}

/**
 * Archived WITH alias — redirects to a successor page. Banner shows:
 *   "Archived. Redirects to `current-promo` (301)."
 * The aliasOf value appears in the banner copy as inline code.
 */
export const ArchivedWithAlias: Story = {
  render: seedSitePages([
    {
      name: 'old-product-page',
      route: '/products/v1',
      template: 'page-default',
      archived: true,
      aliasOf: 'current-product-page',
    },
  ]),
}

/**
 * Unknown page — the banner looks up the name in `site.pages` and
 * finds nothing. Per the component's safe-default behavior, this
 * renders nothing (no banner, no error). Storybook shows the empty
 * state, confirming the lookup failure mode is benign.
 */
export const UnknownPage: Story = {
  render: () => ({
    components: { ArchiveBanner },
    setup() {
      const site = useSiteStore()
      // Intentionally empty — the banner will look up "missing" and
      // not find it.
      site.pages = []
      site.fragments = []
    },
    template: '<ArchiveBanner kind="page" name="missing" />',
  }),
}
