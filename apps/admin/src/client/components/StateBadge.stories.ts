/**
 * Stories for StateBadge — the presentational primitive extracted
 * per design-review-workflow.md "UX implementation foundation".
 *
 * Enumerates every variant × color permutation so the review-workflow
 * UX cuts (ReviewBanner SiteTree badge in Cut 11; PublishPanel
 * destination states in Cut 14) compose a known-visually-approved
 * primitive instead of re-deriving the dot/pill markup.
 *
 * No store seeding — StateBadge is prop-driven. Each story below
 * exercises one meaningful shape (variant × color × with/without
 * label × with/without tooltip). The storybook-vitest run (per
 * ADR-0016) renders each one in light AND dark + axe-checks for
 * color-contrast.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import StateBadge from './StateBadge.vue'

const meta: Meta<typeof StateBadge> = {
  title: 'Primitives / StateBadge',
  component: StateBadge,
  argTypes: {
    variant: { control: 'select', options: ['dot', 'pill'] },
    color: { control: 'select', options: ['warning', 'danger', 'success', 'info', 'muted'] },
    label: { control: 'text' },
    tooltip: { control: 'text' },
  },
}

export default meta
type Story = StoryObj<typeof StateBadge>

/**
 * Dot — warning (amber). Shape and color of the dirty-dot pattern
 * SiteTree uses today for "unpublished changes."
 */
export const DotWarning: Story = {
  args: { variant: 'dot', color: 'warning', tooltip: 'Unsaved changes' },
}

/** Dot — danger (red). Validation error severity. */
export const DotDanger: Story = {
  args: { variant: 'dot', color: 'danger', tooltip: '1 validation error' },
}

/**
 * Dot — success (green). Future consumer: approved review-state
 * marker in the SiteTree badge (Cut 11).
 */
export const DotSuccess: Story = {
  args: { variant: 'dot', color: 'success', tooltip: 'Approved' },
}

/** Dot — info (blue). Validation info severity; "note" cases. */
export const DotInfo: Story = {
  args: { variant: 'dot', color: 'info', tooltip: 'Note' },
}

/** Dot — muted (neutral). Low-emphasis marker; defers to surrounding row. */
export const DotMuted: Story = {
  args: { variant: 'dot', color: 'muted', tooltip: 'Idle' },
}

/**
 * Dot with aria-label but no tooltip — accessible-name without
 * a hover affordance (relevant when the dot sits next to text that
 * already describes the state but ATs still need an anchor).
 */
export const DotWithLabel: Story = {
  args: { variant: 'dot', color: 'warning', label: 'Pending review' },
}

/**
 * Dot with no label and no tooltip — purely decorative. Component
 * emits `aria-hidden="true"`; the row's text carries meaning.
 */
export const DotDecorative: Story = {
  args: { variant: 'dot', color: 'warning' },
}

/**
 * Pill — muted. Mirrors SiteTree's locale badge today (EN / FR / DE).
 */
export const PillMuted: Story = {
  args: { variant: 'pill', color: 'muted', label: 'EN' },
}

/** Pill — warning. Suggested "PENDING" state for the future ReviewBanner. */
export const PillWarning: Story = {
  args: { variant: 'pill', color: 'warning', label: 'PENDING' },
}

/** Pill — danger. Rejected review (Cut 11 DraftRejected consumer). */
export const PillDanger: Story = {
  args: { variant: 'pill', color: 'danger', label: 'REJECTED' },
}

/** Pill — success. Approved review (Cut 11 Approved consumer). */
export const PillSuccess: Story = {
  args: { variant: 'pill', color: 'success', label: 'APPROVED' },
}

/** Pill — info. Draft or informational state. */
export const PillInfo: Story = {
  args: { variant: 'pill', color: 'info', label: 'DRAFT' },
}

/** Pill with tooltip for extra context on hover. */
export const PillWithTooltip: Story = {
  args: { variant: 'pill', color: 'muted', label: 'FR', tooltip: 'French (fr)' },
}
