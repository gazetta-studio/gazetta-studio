/**
 * Stories for TargetCapabilities, the "About this target" dialog
 * (design-public-storage.md, UX check, "Capabilities view"). Each story
 * opens on render so axe checks the open dialog in light and dark.
 * Row copy is transcribed from the design doc's table.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, screen } from 'storybook/test'
import { ref } from 'vue'
import TargetCapabilities from './TargetCapabilities.vue'
import type { TargetInfo } from '../api/client.js'

type Row = TargetInfo['about'][number]

const LABELS: Record<Row['key'], string> = {
  storage: 'Storage',
  history: 'History',
  audit: 'Audit',
  review: 'Content review',
  'publish-approval': 'Publish approval',
  scheduling: 'Scheduling',
  redirects: 'Redirects',
  gone: 'Gone (410)',
  indices: 'Dependency indices',
  deploy: 'Deploy',
}

function target(
  name: string,
  publicStorage: boolean,
  values: Record<Row['key'], string>,
  auditOn?: string,
): TargetInfo {
  return {
    name,
    environment: publicStorage ? 'production' : 'local',
    type: 'static',
    editable: !publicStorage,
    altText: { available: false, auto: false },
    capabilities: { has: [], gaps: [] },
    publicStorage,
    auditHome: auditOn ? { kind: 'target', name: auditOn } : publicStorage ? { kind: 'none' } : { kind: 'self' },
    about: (Object.keys(LABELS) as Row['key'][]).map(key => ({ key, label: LABELS[key], value: values[key] })),
  }
}

const privateRows = {
  history: 'On',
  audit: 'Kept here',
  review: 'Available',
  'publish-approval': 'Not required',
  scheduling: 'Available',
  indices: 'Kept',
}
const publicRows = {
  history: 'Off: storage is public',
  review: 'Not available: storage is public',
  'publish-approval': 'Not required',
  scheduling: 'Not available: storage is public',
  indices: 'Not kept: storage is public',
}

const meta: Meta<typeof TargetCapabilities> = {
  title: 'Targets / TargetCapabilities',
  component: TargetCapabilities,
}
export default meta
type Story = StoryObj<typeof TargetCapabilities>

function story(t: TargetInfo, check: Partial<Record<Row['key'], string>>): Story {
  return {
    render: () => ({
      components: { TargetCapabilities },
      setup: () => ({ visible: ref(true), t }),
      template: '<TargetCapabilities v-model:visible="visible" :target="t" />',
    }),
    play: async () => {
      const panel = await screen.findByRole('dialog')
      await expect(panel).toHaveAccessibleName(`About ${t.name}`)
      for (const [key, value] of Object.entries(check)) {
        const row = panel.querySelector(`[data-testid="target-capability-${key}"] dd`)
        await expect(row?.textContent?.replace(/\s+/g, ' ').trim()).toBe(value.replaceAll('`', ''))
      }
    },
  }
}

/** The editing folder `gazetta init` creates. */
export const PrivateEditingLocal = story(
  target('local', false, {
    ...privateRows,
    storage: 'Private (editing folder)',
    redirects: 'No',
    gone: 'No',
    deploy: 'None',
  }),
  { storage: 'Private (editing folder)', history: 'On', audit: 'Kept here' },
)

/** A cloud target with `publicStorage` unset: its audit events are kept on `local`. */
export const DefaultedPublicCloud = story(
  target(
    'production',
    true,
    {
      ...publicRows,
      storage: 'Public (assumed)',
      audit: 'Kept on `local`',
      redirects: 'Yes',
      gone: 'Yes',
      deploy: 'cloudflare-workers',
    },
    'local',
  ),
  { storage: 'Public (assumed)', history: 'Off: storage is public', audit: 'Kept on `local`' },
)

/**
 * A public production target that needs publish approval: content review
 * isn't available there, but publish approval is, since requests are kept
 * on the source.
 */
export const PublicWithPublishApproval = story(
  target(
    'production',
    true,
    {
      ...publicRows,
      'publish-approval': 'Required, 2 approvers',
      storage: 'Public (declared)',
      audit: 'Kept on `local`',
      redirects: 'Yes',
      gone: 'Yes',
      deploy: 'cloudflare-workers',
    },
    'local',
  ),
  { review: 'Not available: storage is public', 'publish-approval': 'Required, 2 approvers' },
)

/** Every target public: nothing keeps this target's audit events. */
export const PublicNoAuditHome = story(
  target('production', true, {
    ...publicRows,
    storage: 'Public (declared)',
    audit: "Not kept for this target's publishes",
    redirects: 'No',
    gone: 'No',
    deploy: 'None',
  }),
  { storage: 'Public (declared)', audit: "Not kept for this target's publishes" },
)

/** A static host the deploy adapter copies site files to: the storage stays private. */
export const CopyAdapter = story(
  target('pages', false, {
    ...privateRows,
    storage: 'Private (copied to the host by `github-pages`)',
    redirects: 'No',
    gone: 'No',
    deploy: 'github-pages',
  }),
  { storage: 'Private (copied to the host by `github-pages`)', deploy: 'github-pages' },
)

/** Declared private, with history turned off in config. */
export const PrivateHistoryOff = story(
  target('preview', false, {
    ...privateRows,
    storage: 'Private (declared)',
    history: 'Off: turned off in config',
    redirects: 'Yes',
    gone: 'No',
    deploy: 'None',
  }),
  { storage: 'Private (declared)', history: 'Off: turned off in config' },
)
