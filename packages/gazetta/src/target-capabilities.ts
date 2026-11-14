/**
 * The rows of a target's capabilities view (design-public-storage.md,
 * UX check, "Capabilities view"): what the target keeps and what it can
 * do. The admin's "About this target" dialog, `GET /api/targets` and
 * `gazetta targets` all render these rows, so the wording lives here.
 *
 * Each row follows the gate that decides it (`isPublicStorage`,
 * `isHistoryEnabled`, `auditHomeFor`, `inspectTarget`,
 * `mayWriteDepIndices`), so the view can't say something the gates
 * don't do. Values use backticks around names, as the design's copy
 * does; renderers show them as code.
 */
import { auditHomeFor } from './audit-home.js'
import { inspectTarget } from './runtime/runtime-capabilities.js'
import { mayWriteDepIndices } from './state-folders.js'
import { isHistoryEnabled, isPublicStorage, type TargetConfig } from './types.js'

export const TARGET_CAPABILITY_KEYS = [
  'storage',
  'history',
  'audit',
  'review',
  'scheduling',
  'redirects',
  'gone',
  'indices',
  'deploy',
] as const

export type TargetCapabilityKey = (typeof TARGET_CAPABILITY_KEYS)[number]

export interface TargetCapabilityRow {
  key: TargetCapabilityKey
  label: string
  value: string
}

const LABELS: Record<TargetCapabilityKey, string> = {
  storage: 'Storage',
  history: 'History',
  audit: 'Audit',
  review: 'Review',
  scheduling: 'Scheduling',
  redirects: 'Redirects',
  gone: 'Gone (410)',
  indices: 'Dependency indices',
  deploy: 'Deploy',
}

function row(key: TargetCapabilityKey, value: string): TargetCapabilityRow {
  return { key, label: LABELS[key], value }
}

function storageRow(config: TargetConfig): string {
  if (config.publicStorage === true) return 'Public (declared)'
  if (config.publicStorage === false) return 'Private (declared)'
  if (isPublicStorage(config)) return 'Public (assumed)'
  if (config.storage.kind === 'filesystem' && config.editable === true) return 'Private (editing folder)'
  if (config.deploy?.copiesSiteFiles === true) return `Private (copied to the host by \`${config.deploy.name}\`)`
  // isPublicStorage gained a reason to call storage private that this row doesn't name.
  throw new Error(`No storage row wording for private target (storage kind ${config.storage.kind})`)
}

function historyRow(config: TargetConfig): string {
  if (isHistoryEnabled(config)) return 'On'
  return isPublicStorage(config) ? 'Off: storage is public' : 'Off: turned off in config'
}

function auditRow(name: string, configs: Readonly<Record<string, TargetConfig>>): TargetCapabilityRow {
  const home = auditHomeFor(name, configs)
  if (home.kind === 'self') return row('audit', 'Kept here')
  if (home.kind === 'target') return row('audit', `Kept on \`${home.name}\``)
  return row('audit', "Not kept for this target's publishes")
}

export function describeTarget(
  name: string,
  config: TargetConfig,
  allTargetConfigs: Readonly<Record<string, TargetConfig>>,
): TargetCapabilityRow[] {
  const publicStorage = isPublicStorage(config)
  const availability = publicStorage ? 'Not available: storage is public' : 'Available'
  const runtime = inspectTarget(config).has
  return [
    row('storage', storageRow(config)),
    row('history', historyRow(config)),
    auditRow(name, { ...allTargetConfigs, [name]: config }),
    row('review', availability),
    row('scheduling', availability),
    row('redirects', runtime.has('redirects') ? 'Yes' : 'No'),
    row('gone', runtime.has('gone-status') ? 'Yes' : 'No'),
    row('indices', mayWriteDepIndices(publicStorage) ? 'Kept' : 'Not kept: storage is public'),
    row('deploy', config.deploy?.name ?? 'None'),
  ]
}
