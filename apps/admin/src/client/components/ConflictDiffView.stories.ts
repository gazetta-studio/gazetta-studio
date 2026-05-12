/**
 * Stories for ConflictDiffView — exercises the structured-object prop
 * pattern. The component takes two `Record<string, unknown>` props
 * (current vs. pending) and renders a field-by-field semantic diff.
 *
 * Validates: passing real-shape page manifests as props through
 * Storybook's `args` flow; assertion that the component's shallow-diff
 * logic handles primitives, structural fields, and only-in-one cases.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ConflictDiffView from './ConflictDiffView.vue'

const meta: Meta<typeof ConflictDiffView> = {
  title: 'Offline / ConflictDiffView',
  component: ConflictDiffView,
  argTypes: {
    onClose: { action: 'close' },
  },
}

export default meta

type Story = StoryObj<typeof ConflictDiffView>

/**
 * Primitive-only change — title differs, everything else identical.
 * The two text values render side by side under "Title".
 */
export const TitleChanged: Story = {
  args: {
    pending: {
      template: 'page-default',
      route: '/',
      metadata: { title: 'Welcome to Gazetta', description: 'Stateless CMS.' },
      content: { heading: 'Hello, world' },
    },
    current: {
      template: 'page-default',
      route: '/',
      metadata: { title: 'Welcome', description: 'Stateless CMS.' },
      content: { heading: 'Hello, world' },
    },
  },
}

/**
 * Structural change — components array reordered. Shallow diff falls
 * back to the "(N items)" summary because the values aren't primitives.
 */
export const ComponentsReordered: Story = {
  args: {
    pending: {
      template: 'page-default',
      route: '/',
      components: ['@header', 'hero', 'featured', '@footer'],
    },
    current: {
      template: 'page-default',
      route: '/',
      components: ['@header', 'featured', 'hero', '@footer'],
    },
  },
}

/**
 * Only-in-mine: pending added a metadata block that current doesn't
 * have. Diff renders "(only in mine)" / "(only in theirs)" framing.
 */
export const FieldAdded: Story = {
  args: {
    pending: {
      template: 'blog-post',
      route: '/posts/intro',
      metadata: { title: 'Intro', description: 'First post', ogImage: '/og/intro.png' },
    },
    current: {
      template: 'blog-post',
      route: '/posts/intro',
      metadata: { title: 'Intro', description: 'First post' },
    },
  },
}

/**
 * Heavy divergence — multiple fields differ at once. Confirms the
 * banner stays readable when several rows render.
 */
export const MultipleFieldsChanged: Story = {
  args: {
    pending: {
      template: 'page-default',
      route: '/about',
      metadata: { title: 'About us', description: 'Updated description' },
      content: { heading: 'Our story', body: 'Pending body text' },
    },
    current: {
      template: 'page-default',
      route: '/about-us',
      metadata: { title: 'About', description: 'Original description' },
      content: { heading: 'Our story', body: 'Current body text' },
    },
  },
}
