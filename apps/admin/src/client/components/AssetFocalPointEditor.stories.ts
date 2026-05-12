/**
 * Stories for the focal point editor — pure-props baseline.
 *
 * Validates: a component with no store dependency renders cleanly in
 * Storybook and the `args` + `argTypes` Storybook flow works for the
 * `modelValue / @update:modelValue` Vue v-model contract.
 *
 * The image is an inline SVG data URL so the story is self-contained
 * (no fixture asset, no offline-mode concern, no network).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import AssetFocalPointEditor from './AssetFocalPointEditor.vue'

// 800×500 horizon-line SVG — gradient sky over land. Big enough that
// the focal-point preview thumbnails (1:1, 16:9, 4:5, 9:16) show
// visibly different crops when the focal point moves.
const SAMPLE_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1e3a8a" />
          <stop offset="100%" stop-color="#fbbf24" />
        </linearGradient>
      </defs>
      <rect width="800" height="320" fill="url(#sky)" />
      <rect y="320" width="800" height="180" fill="#1f2937" />
      <circle cx="600" cy="120" r="40" fill="#fef3c7" />
      <polygon points="100,320 250,180 380,260 500,210 800,320" fill="#374151" />
    </svg>
  `)

const meta: Meta<typeof AssetFocalPointEditor> = {
  title: 'Asset / FocalPointEditor',
  component: AssetFocalPointEditor,
  args: {
    imageUrl: SAMPLE_IMAGE,
    alt: 'Sunset over rolling hills',
  },
  argTypes: {
    modelValue: { control: 'object' },
    'onUpdate:modelValue': { action: 'update:modelValue' },
  },
}

export default meta

type Story = StoryObj<typeof AssetFocalPointEditor>

/**
 * Unset focal point — marker renders at center (0.5, 0.5) but the
 * "Default" hint is visible so the author knows nothing is persisted.
 */
export const Unset: Story = {
  args: { modelValue: null },
}

/**
 * Explicit focal point at the visual subject (the sun) — top-right
 * quadrant. Aspect-ratio thumbnails should keep the sun in-frame
 * across 1:1, 16:9, 4:5, 9:16 crops.
 */
export const OnSubject: Story = {
  args: { modelValue: { x: 0.75, y: 0.24 } },
}

/**
 * Focal point in the lower-left land area — exercises the marker
 * positioning and the hover-preview interaction in a different
 * quadrant from `OnSubject`.
 */
export const LowerLeft: Story = {
  args: { modelValue: { x: 0.18, y: 0.78 } },
}

/**
 * Decorative-image case: alt is the empty string. The editor still
 * renders the image (the focal point is for the cropping pipeline,
 * not screen readers); the alt-as-empty is purely structural.
 */
export const DecorativeImage: Story = {
  args: { modelValue: { x: 0.5, y: 0.5 }, alt: '' },
}
