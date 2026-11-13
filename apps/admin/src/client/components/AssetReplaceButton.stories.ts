/**
 * Stories for Replace file in the asset detail pane: one per row of
 * design-media.md "Replace (cut 1, M3)". The component is presentational,
 * so each story passes its state directly; `useAssetReplace` drives it in
 * the app (covered by tests/AssetReplaceButton.test.ts).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import type { AssetSummary } from 'gazetta/schema'
import AssetReplaceButton from './AssetReplaceButton.vue'

const replaced: AssetSummary = {
  name: 'hero',
  kind: 'embedded',
  mime: 'image/png',
  size: 48213,
  hash: 'b3c4d5e6',
  width: 1200,
  height: 800,
  alt: 'Sunset over the bay',
  focalPoint: { x: 0.2, y: 0.7 },
  uploadedAt: '2026-10-30T09:00:00Z',
  overrideLocales: [],
  overrideThemes: [],
}

const meta: Meta<typeof AssetReplaceButton> = {
  title: 'Assets / AssetReplaceButton',
  component: AssetReplaceButton,
  args: { assetName: 'hero', assetMime: 'image/jpeg', aiAvailable: true },
  argTypes: {
    onChoose: { action: 'choose' },
    onEditAlt: { action: 'editAlt' },
    onEditFocal: { action: 'editFocal' },
    onSuggest: { action: 'suggest' },
    onDismiss: { action: 'dismiss' },
  },
  decorators: [() => ({ template: '<div style="max-width: 320px; padding: 1rem"><story /></div>' })],
}

export default meta

type Story = StoryObj<typeof AssetReplaceButton>

/** Idle: the button alone; the file chooser offers images only. */
export const Idle: Story = { args: { state: { kind: 'idle' } } }

/** Wrong kind: an audio file chosen for an image. */
export const WrongKind: Story = { args: { state: { kind: 'wrong-kind', fileCategory: 'audio' } } }

/** Working: the button shows its spinner. */
export const Working: Story = { args: { state: { kind: 'working' } } }

/** Done, with AI alt and uses that have their own alt text. */
export const Done: Story = { args: { state: { kind: 'done', asset: replaced, perUseAltCount: 3 } } }

/** Done without AI alt: no Suggest. */
export const DoneWithoutAi: Story = {
  args: { aiAvailable: false, state: { kind: 'done', asset: replaced, perUseAltCount: 3 } },
}

/** Done, no use has its own alt: no per-use line. */
export const DoneNoPerUseAlt: Story = { args: { state: { kind: 'done', asset: replaced, perUseAltCount: 0 } } }

/** Failed: the asset is unchanged. */
export const Failed: Story = { args: { state: { kind: 'failed', reason: 'storage write failed' } } }
