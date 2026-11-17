import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createTargetRegistry,
  createTargetRegistryView,
  listEditableTargets,
  UnknownTargetError,
  NoEditableTargetError,
  resolveEnvVars,
} from '../src/targets.js'
import { filesystemStorage, r2Storage, s3Storage, azureBlobStorage } from '../src/providers/factories.js'
import { missingOptionsOf } from '../src/providers/missing-options.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import { tempDir } from './_helpers/temp.js'

function mockProvider(): StorageProvider {
  return {
    readFile: async () => {
      throw new Error('not impl')
    },
    writeFile: async () => {},
    readDir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    readStream: async () => new ReadableStream(),
    writeStream: async () => {},
  }
}

const testDir = tempDir('targets-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('storage provider factories', () => {
  describe('filesystemStorage', () => {
    it('returns a constructed StorageProvider', () => {
      const provider = filesystemStorage({ path: './output' })
      expect(provider).toBeDefined()
      expect(typeof provider.readFile).toBe('function')
      expect(typeof provider.writeFile).toBe('function')
    })

    it('uses the supplied path for file operations', async () => {
      await mkdir(testDir, { recursive: true })
      const provider = filesystemStorage({ path: resolve(testDir, 'dist') })
      await provider.mkdir('.')
      await provider.writeFile('test.txt', 'hello')
      const content = await provider.readFile('test.txt')
      expect(content).toBe('hello')
    })

    it('defaults path to ./targets/local when no opts given', () => {
      const provider = filesystemStorage()
      expect(provider).toBeDefined()
      // No throw — provider returns; path defaults to ./targets/local relative to CWD.
    })
  })

  // A missing required option fails when the storage is used, not when
  // site.config.ts loads, so a teammate without the production keys can still
  // run `gazetta dev` and publish elsewhere (#1185).
  describe('r2Storage', () => {
    it('constructs without accountId; first use fails naming it', async () => {
      const provider = r2Storage({ accountId: '', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
      await expect(provider.readFile('x')).rejects.toThrow(/r2Storage: "accountId" is required/)
    })
    it('constructs without bucket; first use fails naming it', async () => {
      const provider = r2Storage({ accountId: 'a', bucket: '', accessKeyId: 'k', secretAccessKey: 's' })
      await expect(provider.exists('x')).rejects.toThrow(/r2Storage: "bucket" is required/)
    })
    it('constructs without accessKeyId; first use fails with the env-var hint', async () => {
      const provider = r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: '', secretAccessKey: 's' })
      await expect(provider.writeFile('x', 'y')).rejects.toThrow(
        /r2Storage: "accessKeyId" is required\. Set R2_ACCESS_KEY_ID/,
      )
    })
    it('constructs without secretAccessKey; init fails naming it', async () => {
      const provider = r2Storage({
        accountId: 'a',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: '',
      }) as StorageProvider & { init(): Promise<void> }
      await expect(provider.init()).rejects.toThrow(/r2Storage: "secretAccessKey" is required/)
    })
    it('reports every missing option, in order, with its env variable', () => {
      const provider = r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: '', secretAccessKey: '' })
      const missing = missingOptionsOf(provider)
      expect(missing.map(m => m.option)).toEqual(['accessKeyId', 'secretAccessKey'])
      expect(missing[0].message).toContain('R2_ACCESS_KEY_ID')
      expect(missing[1].message).toContain('R2_SECRET_ACCESS_KEY')
      expect(provider.kind).toBe('r2')
    })
    it('returns a provider on valid options (lazy SDK load)', () => {
      const provider = r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
      expect(provider).toBeDefined()
      expect(missingOptionsOf(provider)).toEqual([])
    })
  })

  describe('s3Storage', () => {
    it('constructs without endpoint; first use fails naming it', async () => {
      const provider = s3Storage({ endpoint: '', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
      await expect(provider.readDir('x')).rejects.toThrow(/s3Storage: "endpoint" is required/)
    })
    it('constructs without credentials; first use fails naming the first', async () => {
      const provider = s3Storage({ endpoint: 'http://x', bucket: 'b', accessKeyId: '', secretAccessKey: '' })
      await expect(provider.readFile('x')).rejects.toThrow(/s3Storage: "accessKeyId" is required/)
      expect(missingOptionsOf(provider).map(m => m.option)).toEqual(['accessKeyId', 'secretAccessKey'])
    })
    it('returns a provider on valid options', () => {
      const provider = s3Storage({
        endpoint: 'http://localhost:9000',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      })
      expect(provider).toBeDefined()
      expect(missingOptionsOf(provider)).toEqual([])
    })
  })

  describe('azureBlobStorage', () => {
    it('constructs without connectionString; first use fails naming it', async () => {
      const provider = azureBlobStorage({ connectionString: '', container: 'c' })
      await expect(provider.readFile('x')).rejects.toThrow(/azureBlobStorage: "connectionString" is required/)
      expect(provider.kind).toBe('azure')
    })
    it('constructs without container; first use fails naming it', async () => {
      const provider = azureBlobStorage({ connectionString: 'conn', container: '' })
      await expect(provider.rm('x')).rejects.toThrow(/azureBlobStorage: "container" is required/)
    })
    it('returns a provider on valid options', () => {
      const provider = azureBlobStorage({ connectionString: 'UseDevelopmentStorage=true', container: 'c' })
      expect(provider).toBeDefined()
      expect(missingOptionsOf(provider)).toEqual([])
    })
  })
})

describe('resolveEnvVars', () => {
  it('expands ${VAR} sentinels from process.env', () => {
    process.env.TEST_VAR = 'value'
    expect(resolveEnvVars('foo-${TEST_VAR}-bar')).toBe('foo-value-bar')
    delete process.env.TEST_VAR
  })
  it('replaces missing vars with empty string', () => {
    expect(resolveEnvVars('foo-${MISSING_VAR}-bar')).toBe('foo--bar')
  })
  it('passes empty input through unchanged', () => {
    expect(resolveEnvVars(undefined)).toBe(undefined)
    expect(resolveEnvVars('')).toBe('')
  })
})

describe('createTargetRegistry', () => {
  it('creates registry from multiple targets', async () => {
    await mkdir(testDir, { recursive: true })
    const targets: Record<string, TargetConfig> = {
      local: { storage: filesystemStorage({ path: resolve(testDir, 'output') }) },
    }
    const registry = await createTargetRegistry(targets)
    expect(registry.size).toBe(1)
    expect(registry.has('local')).toBe(true)
  })

  it('returns empty registry for empty config', async () => {
    const registry = await createTargetRegistry({})
    expect(registry.size).toBe(0)
  })

  it('clears the init guard timer once init settles (#1180)', async () => {
    vi.useFakeTimers()
    try {
      await mkdir(testDir, { recursive: true })
      const targets: Record<string, TargetConfig> = {
        local: { storage: filesystemStorage({ path: resolve(testDir, 'output') }) },
      }
      const registry = await createTargetRegistry(targets)
      expect(registry.has('local')).toBe(true)
      // A pending 10s guard timer would keep the CLI process alive (#1180).
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips targets that fail to initialize', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const targets: Record<string, TargetConfig> = {
      bad: {
        storage: s3Storage({
          endpoint: 'http://nonexistent:9999',
          bucket: 'test',
          accessKeyId: 'k',
          secretAccessKey: 's',
        }),
      },
      good: { storage: filesystemStorage({ path: resolve(testDir, 'output') }) },
    }
    await mkdir(testDir, { recursive: true })
    const registry = await createTargetRegistry(targets)
    expect(registry.has('good')).toBe(true)
    spy.mockRestore()
  })
})

describe('createTargetRegistryView', () => {
  it('resolves known target names to their providers', () => {
    const localP = mockProvider(),
      prodP = mockProvider()
    const providers = new Map<string, StorageProvider>([
      ['local', localP],
      ['prod', prodP],
    ])
    const configs: Record<string, TargetConfig> = {
      local: { storage: localP },
      prod: { storage: prodP, environment: 'production' },
    }
    const registry = createTargetRegistryView(providers, configs)
    expect(registry.get('local')).toBe(localP)
    expect(registry.get('prod')).toBe(prodP)
  })

  it('throws UnknownTargetError for unknown names', () => {
    const registry = createTargetRegistryView(new Map(), {})
    expect(() => registry.get('missing')).toThrow(UnknownTargetError)
    expect(() => registry.get('missing')).toThrow(/missing/)
  })

  it('getConfig returns the config or undefined', () => {
    const configs: Record<string, TargetConfig> = {
      local: { storage: mockProvider() },
    }
    const registry = createTargetRegistryView(new Map([['local', mockProvider()]]), configs)
    expect(registry.getConfig('local')).toBe(configs.local)
    expect(registry.getConfig('nope')).toBeUndefined()
  })

  it('list() returns target names in declaration order', () => {
    const configs: Record<string, TargetConfig> = {
      local: { storage: mockProvider() },
      staging: { storage: mockProvider(), environment: 'staging' },
      prod: { storage: mockProvider(), environment: 'production' },
    }
    const registry = createTargetRegistryView(new Map(), configs)
    expect(registry.list()).toEqual(['local', 'staging', 'prod'])
  })

  describe('defaultEditable', () => {
    it('returns the first editable target in declaration order', () => {
      const configs: Record<string, TargetConfig> = {
        prod: { storage: mockProvider(), environment: 'production' },
        dev: { storage: mockProvider(), publicStorage: false },
        staging: { storage: mockProvider(), environment: 'staging', editable: true, publicStorage: false },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(registry.defaultEditable()).toBe('dev')
    })

    it('respects explicit editable: true on non-local environments', () => {
      const configs: Record<string, TargetConfig> = {
        prod: { storage: mockProvider(), environment: 'production', editable: true },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(registry.defaultEditable()).toBe('prod')
    })

    it('throws NoEditableTargetError when no target is editable', () => {
      const configs: Record<string, TargetConfig> = {
        staging: { storage: mockProvider(), environment: 'staging' },
        prod: { storage: mockProvider(), environment: 'production' },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(() => registry.defaultEditable()).toThrow(NoEditableTargetError)
    })

    it('skips a target whose storage defaults to public', () => {
      const configs: Record<string, TargetConfig> = {
        bucket: { storage: mockProvider() },
        local: { storage: mockProvider(), publicStorage: false },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(registry.defaultEditable()).toBe('local')
    })

    it('throws when no targets at all', () => {
      const registry = createTargetRegistryView(new Map(), {})
      expect(() => registry.defaultEditable()).toThrow(NoEditableTargetError)
    })
  })
})

describe('listEditableTargets', () => {
  it('filters to editable targets in declaration order', () => {
    const configs: Record<string, TargetConfig> = {
      local: { storage: mockProvider(), publicStorage: false },
      staging: { storage: mockProvider(), environment: 'staging' },
      prod: { storage: mockProvider(), environment: 'production', editable: true, publicStorage: false },
      secondLocal: { storage: mockProvider(), publicStorage: false },
      // Public storage defaults to not editable, even with environment unset.
      bucket: { storage: mockProvider() },
    }
    expect(listEditableTargets(configs)).toEqual(['local', 'prod', 'secondLocal'])
  })

  it('returns empty when none editable', () => {
    expect(listEditableTargets({})).toEqual([])
    expect(
      listEditableTargets({
        staging: { storage: mockProvider(), environment: 'staging' },
      }),
    ).toEqual([])
  })
})
