/**
 * Stories for "Sign in a command line" (design-agent-access.md Q15, Q23):
 * one per state. The card is presentational; CliSigninView, which loads it,
 * is covered by tests/CliSigninView.test.ts.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import CliSigninCard from './CliSigninCard.vue'

const adminUrl = 'https://cms.example.com'

const meta: Meta<typeof CliSigninCard> = {
  title: 'Auth / CliSigninCard',
  component: CliSigninCard,
  parameters: { layout: 'fullscreen' },
  argTypes: { onCreate: { action: 'create' } },
}

export default meta

type Story = StoryObj<typeof CliSigninCard>

export const Loading: Story = { args: { state: { kind: 'loading' } } }

export const SignedOut: Story = { args: { state: { kind: 'signed-out' } } }

export const LoadError: Story = { args: { state: { kind: 'error', detail: 'Internal Server Error' } } }

/** Any admin where the code is approved in the browser: only the command. */
export const Approve: Story = {
  args: { state: { kind: 'ready', adminUrl, setup: { trustMode: 'forwarded-user', paste: false } } },
}

/** Behind Cloudflare Access with a shared service token. */
export const CloudflareServiceToken: Story = {
  args: {
    state: {
      kind: 'ready',
      adminUrl,
      setup: {
        trustMode: 'cloudflare-access',
        paste: false,
        cloudflare: {
          clientId: '8c5a1f0e2b6d4e3a9f7c.access',
          clientSecret: 'f3b2c9d1e8a7f6b5c4d3e2f1a0b9c8d7e6f5a4b3',
        },
      },
    },
  },
}

/** Behind ALB: name the machine and create a sign-in. */
export const Paste: Story = {
  args: { state: { kind: 'ready', adminUrl, setup: { trustMode: 'aws-cognito', paste: true } } },
}

/** A sign-in is being created. */
export const Creating: Story = {
  args: { state: { kind: 'ready', adminUrl, setup: { trustMode: 'aws-cognito', paste: true } }, busy: true },
}

/** Created: the secret is shown once. */
export const Created: Story = {
  args: {
    state: {
      kind: 'ready',
      adminUrl,
      setup: { trustMode: 'aws-cognito', paste: true },
      created: {
        machine: 'build-server',
        grantSecret: '4f6e1c2a-77b0-4a1e-9d3c-5b8e2f0a1c9d.Zm9vYmFyYmF6cXV4cXV1eGNvcmdl',
      },
    },
  },
}
