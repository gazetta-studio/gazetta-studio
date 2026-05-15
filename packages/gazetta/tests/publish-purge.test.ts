import { describe, expect, it } from 'vitest'
import { selectPurgeTargets } from '../src/publish-purge.js'
import type { TargetConfig } from '../src/types.js'

function makeTarget(overrides: Partial<TargetConfig> = {}): TargetConfig {
  // Cast through unknown — TargetConfig requires `storage: StorageProvider`,
  // but selectPurgeTargets only reads keys + cache.purge so a stub is enough.
  return {
    cache: {
      purge: { type: 'cloudflare', apiToken: 'tok' },
    },
    ...overrides,
  } as unknown as TargetConfig
}

describe('selectPurgeTargets', () => {
  it('returns every target when targetName is undefined', () => {
    const targets = {
      local: makeTarget(),
      production: makeTarget(),
    }
    const result = selectPurgeTargets(targets, undefined)
    expect(result.map(([name]) => name)).toEqual(['local', 'production'])
  })

  it('returns only the named target when targetName is set', () => {
    const targets = {
      local: makeTarget(),
      production: makeTarget(),
    }
    const result = selectPurgeTargets(targets, 'local')
    expect(result.map(([name]) => name)).toEqual(['local'])
  })

  it('does not include sibling targets — closes #372', () => {
    // The bug: `gazetta publish local` was purging production's CDN cache
    // because the purge loop iterated `Object.entries(siteYaml.targets)`
    // without honoring the targetName argument.
    const targets = {
      local: makeTarget({ cache: { purge: { type: 'cloudflare', apiToken: 'local-tok' } } }),
      production: makeTarget({ cache: { purge: { type: 'cloudflare', apiToken: 'prod-tok' } } }),
    }
    const result = selectPurgeTargets(targets, 'local')
    const names = result.map(([name]) => name)
    expect(names).not.toContain('production')
    expect(names).toEqual(['local'])
  })

  it('returns an empty list when the named target does not exist', () => {
    const targets = {
      local: makeTarget(),
    }
    const result = selectPurgeTargets(targets, 'staging')
    expect(result).toEqual([])
  })

  it('preserves the target config in each tuple', () => {
    const localTarget = makeTarget({ cache: { purge: { type: 'cloudflare', apiToken: 'local-tok' } } })
    const targets = { local: localTarget }
    const result = selectPurgeTargets(targets, 'local')
    expect(result).toEqual([['local', localTarget]])
  })
})
