/**
 * Tests for `deploy-target-type-supported` validator (Cut 2 of #203).
 *
 * Enforces Q5 of the deploy design pass: adapter declares
 * `supports: readonly TargetType[]`; mismatch with `target.type` is
 * an error-severity issue. Runs at `cli` stage; publish-route
 * enforcement uses target-capability inspection separately (the
 * validator framework's pre-publish scope doesn't carry target
 * context today).
 *
 * Per rule 26: fresh memoryStorage + fresh site fixtures per test.
 */
import { describe, expect, it } from 'vitest'
import type { Site } from '../src/site-loader.js'
import type { DeployAdapter, DeployContext, DeployResult } from '../src/deploy/types.js'
import type { TargetConfig, TargetType, StorageProvider } from '../src/types.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { deployTargetTypeSupported } from '../src/validation/validators/deploy-target-type-supported.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function makeSite(targets: Record<string, Partial<TargetConfig>>): Site {
  const storage = memoryStorage()
  return {
    manifest: { name: 'test', targets: targets as Record<string, TargetConfig> },
    pages: new Map(),
    pageLocales: new Map(),
    fragments: new Map(),
    fragmentLocales: new Map(),
    contentRoot: createContentRoot(storage, ''),
    storage,
    siteDir: '',
    templatesDir: '',
  } as Site
}

function cliInput(site: Site): ValidatorInput {
  return {
    stage: 'cli',
    site,
    contentRoot: site.contentRoot,
    storage: site.storage as StorageProvider,
    scope: { kind: 'cli' },
  }
}

function mockAdapter(name: string, supports: readonly TargetType[]): DeployAdapter {
  return {
    name,
    supports,
    async execute(_ctx: DeployContext): Promise<DeployResult> {
      return {}
    },
  }
}

describe('deploy-target-type-supported', () => {
  it('declares name + cli stage + error severity', () => {
    expect(deployTargetTypeSupported.name).toBe('deploy-target-type-supported')
    expect(deployTargetTypeSupported.source).toBe('gazetta')
    expect(deployTargetTypeSupported.stages).toContain('cli')
    expect(deployTargetTypeSupported.defaultSeverity('cli')).toBe('error')
  })

  it('flags mismatch: esi target with static-only adapter', async () => {
    const site = makeSite({
      production: {
        type: 'dynamic', // esi role today; widens to 'esi' per design-rendering.md Cut 1
        deploy: mockAdapter('github-pages', ['static']),
      },
    })
    const issues = await deployTargetTypeSupported.validate(cliInput(site))
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].message).toContain('production')
    expect(issues[0].message).toContain('github-pages')
    expect(issues[0].message).toContain('static')
  })

  it('passes: static target with static-capable adapter', async () => {
    const site = makeSite({
      'prod-pages': {
        type: 'static',
        deploy: mockAdapter('github-pages', ['static']),
      },
    })
    const issues = await deployTargetTypeSupported.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('passes: target with multi-type adapter (static included)', async () => {
    const site = makeSite({
      prod: {
        type: 'static',
        deploy: mockAdapter('cf-pages', ['static', 'dynamic']),
      },
    })
    const issues = await deployTargetTypeSupported.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('skips targets without a deploy adapter (no false positive)', async () => {
    const site = makeSite({
      local: { type: 'static' }, // no deploy
    })
    const issues = await deployTargetTypeSupported.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('reports one issue per incompatible target', async () => {
    const site = makeSite({
      'bad-1': { type: 'dynamic', deploy: mockAdapter('static-only', ['static']) },
      'bad-2': { type: 'dynamic', deploy: mockAdapter('static-only', ['static']) },
      ok: { type: 'static', deploy: mockAdapter('static-only', ['static']) },
    })
    const issues = await deployTargetTypeSupported.validate(cliInput(site))
    expect(issues).toHaveLength(2)
    const targetsFlagged = issues.map(i => i.message)
    expect(targetsFlagged.some(m => m.includes('bad-1'))).toBe(true)
    expect(targetsFlagged.some(m => m.includes('bad-2'))).toBe(true)
  })

  it('does NOT run at save-delta or background scopes', async () => {
    expect(deployTargetTypeSupported.stages).not.toContain('save-delta')
    expect(deployTargetTypeSupported.stages).not.toContain('background')
  })
})
