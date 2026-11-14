/**
 * The capabilities view's rows (design-public-storage.md, UX check,
 * "Capabilities view"): each row's copy follows the gate that decides it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DeployAdapter } from '../src/deploy/types.js'
import { describeTarget } from '../src/target-capabilities.js'
import type { StorageKind, TargetConfig } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const depIndices = vi.hoisted(() => ({ safeOnPublic: false }))
vi.mock('../src/state-folders.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/state-folders.js')>()
  return {
    ...real,
    mayWriteDepIndices: (publicStorage: boolean) => !publicStorage || depIndices.safeOnPublic,
  }
})

// Lets a test stand in for a future reason isPublicStorage might call storage private.
const publicStorageOverride = vi.hoisted(() => ({ forcePrivate: false }))
vi.mock('../src/types.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/types.js')>()
  return {
    ...real,
    isPublicStorage: (t: Parameters<typeof real.isPublicStorage>[0]) =>
      publicStorageOverride.forcePrivate ? false : real.isPublicStorage(t),
  }
})

function storage(kind: StorageKind = 'r2') {
  return { ...memoryStorage(), kind }
}

const copyAdapter: DeployAdapter = {
  name: 'github-pages',
  supports: ['static'],
  copiesSiteFiles: true,
  execute: async () => ({}),
}
const workerAdapter = {
  name: 'cloudflare-workers',
  supports: ['dynamic'],
  execute: async () => ({}),
  workerRuntimeConfig: () => ({ bucketBinding: 'SITE' }),
} as DeployAdapter

const local: TargetConfig = { storage: storage('filesystem'), editable: true }

function rows(name: string, config: TargetConfig, all: Record<string, TargetConfig> = { [name]: config }) {
  return Object.fromEntries(describeTarget(name, config, all).map(r => [r.key, r.value]))
}

describe('describeTarget', () => {
  it('lists the rows in the capabilities table order', () => {
    expect(describeTarget('local', local, { local }).map(r => r.key)).toEqual([
      'storage',
      'history',
      'audit',
      'review',
      'scheduling',
      'redirects',
      'gone',
      'indices',
      'deploy',
    ])
  })

  it.each<[string, TargetConfig, string]>([
    ['declared public', { storage: storage(), publicStorage: true }, 'Public (declared)'],
    ['assumed public', { storage: storage() }, 'Public (assumed)'],
    ['declared private', { storage: storage(), publicStorage: false }, 'Private (declared)'],
    ['editing folder', { storage: storage('filesystem'), editable: true }, 'Private (editing folder)'],
    ['copy adapter', { storage: storage(), deploy: copyAdapter }, 'Private (copied to the host by `github-pages`)'],
  ])('storage row: %s', (_label, config, value) => {
    expect(rows('t', config).storage).toBe(value)
  })

  it('storage row refuses a private target it has no wording for, rather than naming no adapter', () => {
    publicStorageOverride.forcePrivate = true
    try {
      expect(() => rows('t', { storage: storage(), deploy: workerAdapter })).toThrow(/No storage row wording/)
    } finally {
      publicStorageOverride.forcePrivate = false
    }
  })

  it.each<[string, TargetConfig, string]>([
    ['private', { storage: storage(), publicStorage: false }, 'On'],
    ['public', { storage: storage() }, 'Off: storage is public'],
    [
      'turned off',
      { storage: storage(), publicStorage: false, history: { enabled: false } },
      'Off: turned off in config',
    ],
  ])('history row: %s', (_label, config, value) => {
    expect(rows('t', config).history).toBe(value)
  })

  describe('audit row follows the fallback order', () => {
    const production: TargetConfig = { storage: storage() }

    it('a private target keeps its own', () => {
      expect(rows('local', local, { local, production }).audit).toBe('Kept here')
    })

    it('a public target uses the first private target in config order', () => {
      const staging: TargetConfig = { storage: storage(), publicStorage: false }
      const all = { production, local, staging }
      const row = describeTarget('production', production, all).find(r => r.key === 'audit')
      expect(row).toEqual({ key: 'audit', label: 'Audit', value: 'Kept on `local`' })
    })

    it('with no private target, audit is not kept', () => {
      expect(rows('production', production, { production }).audit).toBe("Not kept for this target's publishes")
    })
  })

  it('review and scheduling are unavailable on public storage only', () => {
    expect(rows('local', local)).toMatchObject({ review: 'Available', scheduling: 'Available' })
    expect(rows('p', { storage: storage() })).toMatchObject({
      review: 'Not available: storage is public',
      scheduling: 'Not available: storage is public',
    })
  })

  it.each<[string, TargetConfig, string, string]>([
    ['plain static', { storage: storage(), type: 'static' }, 'No', 'No'],
    ['host redirects', { storage: storage(), type: 'static', redirects: { format: 'cloudflare' } }, 'Yes', 'No'],
    ['worker', { storage: storage(), deploy: workerAdapter }, 'Yes', 'Yes'],
  ])('redirects and gone follow the runtime capabilities: %s', (_label, config, redirects, gone) => {
    expect(rows('t', config)).toMatchObject({ redirects, gone })
  })

  it('indices follow mayWriteDepIndices', () => {
    const publicTarget: TargetConfig = { storage: storage() }
    expect(rows('local', local).indices).toBe('Kept')
    expect(rows('p', publicTarget).indices).toBe('Not kept: storage is public')
    depIndices.safeOnPublic = true
    try {
      expect(rows('p', publicTarget).indices).toBe('Kept')
    } finally {
      depIndices.safeOnPublic = false
    }
  })

  it('deploy shows the adapter name, or None', () => {
    expect(rows('local', local).deploy).toBe('None')
    expect(rows('w', { storage: storage(), deploy: workerAdapter }).deploy).toBe('cloudflare-workers')
  })
})
