/**
 * Public storage cut 4 (#1592): history and review follow
 * `isPublicStorage` (design-public-storage.md Q3, Q5).
 */
import { describe, expect, it } from 'vitest'
import { filesystemStorage, r2Storage } from '../src/providers/factories.js'
import { resolveSaveReviewPolicy } from '../src/review/save-gate.js'
import { historyOffReason, isHistoryEnabled, type TargetConfig } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const r2 = () => r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })

describe('isHistoryEnabled', () => {
  it.each<[string, TargetConfig]>([
    ['cloud storage with publicStorage unset', { storage: r2() }],
    ['publicStorage: true', { storage: memoryStorage(), publicStorage: true }],
    ['a public target with history retention set', { storage: r2(), history: { retention: 10 } }],
  ])('is false for %s', (_, target) => {
    expect(isHistoryEnabled(target)).toBe(false)
  })

  it.each<[string, TargetConfig]>([
    ['publicStorage: false', { storage: r2(), publicStorage: false }],
    ['an editable filesystem target', { storage: filesystemStorage({ path: '/tmp/x' }), editable: true }],
  ])('defaults to true for %s', (_, target) => {
    expect(isHistoryEnabled(target)).toBe(true)
  })

  it('stays off for a private target that turns it off', () => {
    expect(isHistoryEnabled({ storage: r2(), publicStorage: false, history: { enabled: false } })).toBe(false)
  })
})

describe('historyOffReason', () => {
  it('names public storage for a public target', () => {
    expect(historyOffReason('production', { storage: r2() })).toBe(
      `History is off because "production"'s storage is public`,
    )
  })

  it('names the config for a private target that turned history off', () => {
    expect(historyOffReason('staging', { storage: r2(), publicStorage: false, history: { enabled: false } })).toBe(
      'History is turned off for "staging" (site.config.ts: history.enabled: false)',
    )
  })
})

describe('resolveSaveReviewPolicy', () => {
  const reviewWorkflow = { enabled: true }

  it('is undefined for a public target even with review enabled', () => {
    const manifest = { targets: { production: { storage: r2(), reviewWorkflow } } }
    expect(resolveSaveReviewPolicy(manifest, 'production')).toBeUndefined()
  })

  it('is undefined for a public target when review is enabled site-wide', () => {
    const manifest = { reviewWorkflow, targets: { production: { storage: r2() } } }
    expect(resolveSaveReviewPolicy(manifest, 'production')).toBeUndefined()
  })

  it('returns the policy for a private target', () => {
    const manifest = { targets: { local: { storage: r2(), publicStorage: false, reviewWorkflow } } }
    expect(resolveSaveReviewPolicy(manifest, 'local')).toMatchObject({ enabled: true })
  })
})
