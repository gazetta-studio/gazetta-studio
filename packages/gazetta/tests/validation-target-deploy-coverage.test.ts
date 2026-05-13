/**
 * Tests for `target-deploy-coverage` validator (Cut 2 of #203).
 *
 * Surfaces the capability-gap UX at cli stage: when a non-local
 * target has runtime constraints (`type: 'dynamic'`) but no
 * `deploy:` configured, emit info-severity issue pointing to
 * docs/container-deployment.md.
 *
 * `environment: 'local'` targets (dev / `gazetta serve` self-hosted)
 * are skipped — they don't need a platform deploy adapter.
 *
 * Per rule 26: fresh memoryStorage + fresh site fixtures per test.
 */
import { describe, expect, it } from 'vitest'
import type { Site } from '../src/site-loader.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { createContentRoot } from '../src/content-root.js'
import { targetDeployCoverage } from '../src/validation/validators/target-deploy-coverage.js'
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

describe('target-deploy-coverage', () => {
  it('declares name + cli stage + info severity', () => {
    expect(targetDeployCoverage.name).toBe('target-deploy-coverage')
    expect(targetDeployCoverage.source).toBe('gazetta')
    expect(targetDeployCoverage.stages).toContain('cli')
    expect(targetDeployCoverage.defaultSeverity('cli')).toBe('info')
  })

  it('emits info when non-local dynamic target has no deploy', async () => {
    const site = makeSite({
      'production-fly': {
        type: 'dynamic',
        environment: 'production',
        storage: memoryStorage() as unknown as StorageProvider,
      },
    })
    const issues = await targetDeployCoverage.validate(cliInput(site))
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].message).toContain('production-fly')
    expect(issues[0].message).toContain('container-deployment.md')
  })

  it('skips local targets (dev / gazetta serve)', async () => {
    const site = makeSite({
      local: {
        type: 'dynamic',
        environment: 'local',
        storage: memoryStorage() as unknown as StorageProvider,
      },
    })
    const issues = await targetDeployCoverage.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('skips when target has a deploy adapter configured', async () => {
    const site = makeSite({
      prod: {
        type: 'dynamic',
        environment: 'production',
        storage: memoryStorage() as unknown as StorageProvider,
        deploy: {
          name: 'fake',
          supports: ['dynamic'],
          async execute() {
            return {}
          },
        },
      },
    })
    const issues = await targetDeployCoverage.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('skips static targets (no runtime constraint)', async () => {
    const site = makeSite({
      'prod-static': {
        type: 'static',
        environment: 'production',
        storage: memoryStorage() as unknown as StorageProvider,
      },
    })
    const issues = await targetDeployCoverage.validate(cliInput(site))
    expect(issues).toEqual([])
  })

  it('emits one info per matching target', async () => {
    const site = makeSite({
      'fly-1': { type: 'dynamic', environment: 'production', storage: memoryStorage() as unknown as StorageProvider },
      'fly-2': { type: 'dynamic', environment: 'staging', storage: memoryStorage() as unknown as StorageProvider },
      local: { type: 'static', environment: 'local', storage: memoryStorage() as unknown as StorageProvider },
    })
    const issues = await targetDeployCoverage.validate(cliInput(site))
    expect(issues).toHaveLength(2)
  })

  it('does NOT run at save-delta, background, or pre-publish scopes', async () => {
    expect(targetDeployCoverage.stages).not.toContain('save-delta')
    expect(targetDeployCoverage.stages).not.toContain('background')
    expect(targetDeployCoverage.stages).not.toContain('pre-publish')
  })
})
