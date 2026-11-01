/**
 * Stories for the CLI sign-in page (design-agent-access.md Q19, Q21): one per
 * state. The card is presentational, so each story passes its state directly;
 * CliLoginView, which loads it, is covered by tests/CliLoginView.test.ts.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import CliLoginCard from './CliLoginCard.vue'

const login = {
  code: 'ABCD-EFGH',
  machine: 'alice-macbook',
  ip: '203.0.113.7',
  startedAt: '2026-11-01T09:30:00Z',
  expiresAt: '2026-11-01T09:40:00Z',
  state: 'pending' as const,
}

const meta: Meta<typeof CliLoginCard> = {
  title: 'Auth / CliLoginCard',
  component: CliLoginCard,
  parameters: { layout: 'fullscreen' },
  argTypes: { onApprove: { action: 'approve' }, onDeny: { action: 'deny' }, onEnd: { action: 'end' } },
}

export default meta

type Story = StoryObj<typeof CliLoginCard>

export const Loading: Story = { args: { state: { kind: 'loading' } } }

export const Pending: Story = { args: { state: { kind: 'pending', login } } }

/** No IP address reported: the row is left out. */
export const PendingWithoutIp: Story = {
  args: { state: { kind: 'pending', login: { ...login, ip: undefined } } },
}

/** A decision is being sent: both buttons are disabled. */
export const Deciding: Story = { args: { state: { kind: 'pending', login }, busy: true } }

export const Approved: Story = { args: { state: { kind: 'approved' } } }

export const Denied: Story = { args: { state: { kind: 'denied' } } }

export const Expired: Story = { args: { state: { kind: 'expired' } } }

export const NotFound: Story = { args: { state: { kind: 'not-found' } } }

export const LoadError: Story = {
  args: { state: { kind: 'error', detail: 'Approve this sign-in from a browser.' } },
}

const elevation = {
  ...login,
  code: 'WXYZ-1234',
  kind: 'elevation' as const,
  scope: 'non-production' as const,
}

/** `gz elevate`: publishing, deleting and restoring on non-production targets. */
export const ElevationPending: Story = { args: { state: { kind: 'pending', login: elevation } } }

/** `gz elevate --production`: production needs its own elevation. */
export const ElevationPendingProduction: Story = {
  args: { state: { kind: 'pending', login: { ...elevation, scope: 'production' } } },
}

/** Approved and running: End now ends it before its 15 minutes run out. */
export const ElevationActive: Story = {
  args: {
    state: {
      kind: 'elevation-active',
      machine: 'alice-macbook',
      elevationId: 'elv_1',
      endsAt: '2026-11-01T09:45:00Z',
    },
  },
}

export const ElevationEnded: Story = {
  args: { state: { kind: 'elevation-ended', machine: 'alice-macbook' } },
}

export const ElevationDenied: Story = { args: { state: { kind: 'denied', elevation: true } } }
