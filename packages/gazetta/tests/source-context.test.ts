import { describe, it, expect } from 'vitest'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import { createTargetRegistryView, NoEditableTargetError, UnknownTargetError } from '../src/targets.js'
import {
  createSourceContext,
  createSourceContextFromRegistry,
  staticSourceResolver,
  registrySourceResolver,
} from '../src/admin-api/source-context.js'

function mockProvider(tag = 'mock'): StorageProvider {
  return {
    readFile: async () => tag,
    writeFile: async () => {},
    readDir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
  }
}

describe('createSourceContext', () => {
  it('wraps storage + siteDir into a ContentRoot-backed context', () => {
    const storage = mockProvider()
    const source = createSourceContext({ storage, siteDir: '/abs/site' })
    expect(source.storage).toBe(storage)
    expect(source.siteDir).toBe('/abs/site')
    expect(source.projectSiteDir).toBe('/abs/site') // defaults to siteDir
    expect(source.contentRoot.storage).toBe(storage)
    expect(source.contentRoot.rootPath).toBe('/abs/site')
    expect(source.contentRoot.path('pages', 'home')).toBe('/abs/site/pages/home')
  })

  it('distinguishes siteDir (storage rooting) from projectSiteDir', () => {
    const storage = mockProvider()
    const source = createSourceContext({
      storage,
      siteDir: '', // target-rooted storage
      projectSiteDir: '/abs/project/sites/main',
    })
    expect(source.siteDir).toBe('')
    expect(source.projectSiteDir).toBe('/abs/project/sites/main')
    // Content paths are target-relative
    expect(source.contentRoot.path('pages', 'home')).toBe('pages/home')
  })
})

describe('createSourceContextFromRegistry', () => {
  const configs: Record<string, TargetConfig> = {
    local: { storage: { type: 'filesystem' } },
    staging: { storage: { type: 'r2' }, environment: 'staging' },
    prod: { storage: { type: 'r2' }, environment: 'production' },
  }

  it('picks the default editable target when no name is given', () => {
    const localProvider = mockProvider('local-provider')
    const providers = new Map<string, StorageProvider>([
      ['local', localProvider],
      ['staging', mockProvider('staging')],
      ['prod', mockProvider('prod')],
    ])
    const registry = createTargetRegistryView(providers, configs)

    const source = createSourceContextFromRegistry({ registry, projectSiteDir: '/abs/site' })
    expect(source.storage).toBe(localProvider)
    expect(source.siteDir).toBe('') // storage-rooting prefix — empty for registry-sourced
    expect(source.projectSiteDir).toBe('/abs/site')
  })

  it('honors an explicit targetName', () => {
    const stagingProvider = mockProvider('staging-provider')
    const providers = new Map<string, StorageProvider>([
      ['local', mockProvider('local')],
      ['staging', stagingProvider],
    ])
    const registry = createTargetRegistryView(providers, configs)

    const source = createSourceContextFromRegistry({ registry, targetName: 'staging', projectSiteDir: '.' })
    expect(source.storage).toBe(stagingProvider)
  })

  it('throws NoEditableTargetError when no editable target exists and no name is given', () => {
    const readOnlyConfigs: Record<string, TargetConfig> = {
      staging: { storage: { type: 'r2' }, environment: 'staging' },
      prod: { storage: { type: 'r2' }, environment: 'production' },
    }
    const registry = createTargetRegistryView(new Map(), readOnlyConfigs)
    expect(() => createSourceContextFromRegistry({ registry, projectSiteDir: '.' })).toThrow(NoEditableTargetError)
  })

  it('throws UnknownTargetError when an explicit targetName is not in the registry', () => {
    const registry = createTargetRegistryView(new Map(), configs)
    expect(() => createSourceContextFromRegistry({ registry, targetName: 'missing', projectSiteDir: '.' })).toThrow(
      UnknownTargetError,
    )
  })
})

describe('staticSourceResolver', () => {
  it('returns the same SourceContext regardless of requested target name', () => {
    const source = createSourceContext({ storage: mockProvider(), siteDir: '/abs/site' })
    const resolve = staticSourceResolver(source)
    expect(resolve(undefined)).toBe(source)
    expect(resolve('local')).toBe(source)
    expect(resolve('staging')).toBe(source)
  })
})

describe('registrySourceResolver', () => {
  const configs: Record<string, TargetConfig> = {
    local: { storage: { type: 'filesystem' } },
    staging: { storage: { type: 'r2' }, environment: 'staging', editable: true },
    prod: { storage: { type: 'r2' }, environment: 'production' },
  }

  function buildRegistry() {
    const providers = new Map<string, StorageProvider>([
      ['local', mockProvider('local-p')],
      ['staging', mockProvider('staging-p')],
      ['prod', mockProvider('prod-p')],
    ])
    return createTargetRegistryView(providers, configs)
  }

  it('resolves to the default editable target when no name is given', async () => {
    const registry = buildRegistry()
    const resolve = registrySourceResolver({ registry, projectSiteDir: '/abs/site' })
    const source = await resolve(undefined)
    // local is the first editable target in declaration order
    expect(source.storage).toBe(registry.get('local'))
  })

  it('resolves to the requested target when named', async () => {
    const registry = buildRegistry()
    const resolve = registrySourceResolver({ registry, projectSiteDir: '/abs/site' })
    const source = await resolve('staging')
    expect(source.storage).toBe(registry.get('staging'))
  })

  it('memoizes one context per target name', async () => {
    const resolve = registrySourceResolver({ registry: buildRegistry(), projectSiteDir: '/abs/site' })
    const a = await resolve('staging')
    const b = await resolve('staging')
    expect(a).toBe(b)
  })

  it('returns distinct contexts for different target names', async () => {
    const resolve = registrySourceResolver({ registry: buildRegistry(), projectSiteDir: '/abs/site' })
    const local = await resolve('local')
    const staging = await resolve('staging')
    expect(local).not.toBe(staging)
    expect(local.storage).not.toBe(staging.storage)
  })

  it('throws UnknownTargetError for names not in the registry', async () => {
    const resolve = registrySourceResolver({ registry: buildRegistry(), projectSiteDir: '/abs/site' })
    await expect(async () => await resolve('missing')).rejects.toThrow(UnknownTargetError)
  })

  it('throws NoEditableTargetError when resolving the default on a registry with none editable', async () => {
    const readOnlyConfigs: Record<string, TargetConfig> = {
      staging: { storage: { type: 'r2' }, environment: 'staging' },
      prod: { storage: { type: 'r2' }, environment: 'production' },
    }
    const providers = new Map<string, StorageProvider>([
      ['staging', mockProvider('staging')],
      ['prod', mockProvider('prod')],
    ])
    const registry = createTargetRegistryView(providers, readOnlyConfigs)
    const resolve = registrySourceResolver({ registry, projectSiteDir: '.' })
    await expect(async () => await resolve(undefined)).rejects.toThrow(NoEditableTargetError)
  })
})
