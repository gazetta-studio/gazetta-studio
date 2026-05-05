import { resolve, join } from 'node:path'
import type { StorageProvider, TargetConfig, StorageConfig } from './types.js'
import { isEditable } from './types.js'
import { createFilesystemProvider } from './providers/filesystem.js'

/**
 * Target resolution surface used by route handlers and anything that needs
 * to act on a specific named target. Narrow by intent: route factories that
 * only list targets take `list()`; handlers that load content take `get()`;
 * publish-aware code reads `getConfig()` to branch on type or environment.
 *
 * Implementations decide how to initialize providers — eagerly at boot,
 * lazily on first access, or mocked for tests.
 */
export interface TargetRegistry {
  /** Resolve a target name to its storage provider. Throws if unknown. */
  get(name: string): StorageProvider
  /** Configuration for a target (type, environment, editable). */
  getConfig(name: string): TargetConfig | undefined
  /** All known target names. */
  list(): string[]
  /**
   * Name of the default editable target for this site. Throws if none exists.
   * Resolution: first target where `isEditable(config) === true`, in the order
   * they appear in site.config.ts.
   */
  defaultEditable(): string
}

export class UnknownTargetError extends Error {
  constructor(name: string) {
    super(`Unknown target: ${name}`)
    this.name = 'UnknownTargetError'
  }
}
export class NoEditableTargetError extends Error {
  constructor() {
    super('No editable target is configured. At least one target in site.config.ts must be editable.')
    this.name = 'NoEditableTargetError'
  }
}

/**
 * Build a TargetRegistry from already-initialized providers and their configs.
 * The factory that boots the dev server populates `providers` by running
 * `createStorageProvider` per target; tests pass in-memory providers.
 */
export function createTargetRegistryView(
  providers: Map<string, StorageProvider>,
  configs: Record<string, TargetConfig>,
): TargetRegistry {
  const orderedNames = Object.keys(configs)
  return {
    get(name) {
      const p = providers.get(name)
      if (!p) throw new UnknownTargetError(name)
      return p
    },
    getConfig(name) {
      return configs[name]
    },
    list() {
      return [...orderedNames]
    },
    defaultEditable() {
      for (const name of orderedNames) {
        const cfg = configs[name]
        if (cfg && isEditable(cfg)) return name
      }
      throw new NoEditableTargetError()
    },
  }
}

/** Find all editable targets in declaration order. Pure helper. */
export function listEditableTargets(configs: Record<string, TargetConfig>): string[] {
  return Object.entries(configs)
    .filter(([, cfg]) => isEditable(cfg))
    .map(([name]) => name)
}

export function resolveEnvVars(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
}

/**
 * Build a storage provider from config.
 *
 * For filesystem targets, `path` defaults to `./targets/<targetName>` (relative
 * to the site dir). Users can override by setting `path` explicitly in
 * site.config.ts — useful for shared drives, existing layouts, or multi-site setups
 * that need custom paths. If neither `path` nor `targetName` is available for
 * a filesystem target, throws.
 */
export async function createStorageProvider(
  config: StorageConfig,
  siteDir: string,
  targetName?: string,
): Promise<StorageProvider> {
  switch (config.type) {
    case 'filesystem': {
      const path = config.path ?? (targetName ? join('targets', targetName) : undefined)
      if (!path) throw new Error('Filesystem storage requires "path" (or a target name to derive the default from)')
      return createFilesystemProvider(resolve(siteDir, path))
    }
    case 'azure-blob': {
      const connectionString = resolveEnvVars(config.connectionString)
      if (!connectionString) throw new Error('Azure Blob storage requires "connectionString"')
      if (!config.container) throw new Error('Azure Blob storage requires "container"')
      try {
        const { createAzureBlobProvider } = await import('./providers/azure-blob.js')
        return createAzureBlobProvider({ connectionString, container: config.container })
      } catch {
        throw new Error('Azure Blob storage requires @azure/storage-blob. Install it: npm install @azure/storage-blob')
      }
    }
    case 's3': {
      const endpoint = resolveEnvVars(config.endpoint)
      if (!endpoint) throw new Error('S3 storage requires "endpoint"')
      if (!config.bucket) throw new Error('S3 storage requires "bucket"')
      try {
        const { createS3Provider } = await import('./providers/s3.js')
        return createS3Provider({
          endpoint,
          bucket: config.bucket,
          accessKeyId: resolveEnvVars(config.accessKeyId) ?? 'minioadmin',
          secretAccessKey: resolveEnvVars(config.secretAccessKey) ?? 'minioadmin',
          region: config.region,
        })
      } catch {
        throw new Error(
          'S3 storage requires @aws-sdk/client-s3 and @aws-sdk/lib-storage. ' +
            'Install them: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage',
        )
      }
    }
    case 'r2': {
      if (!config.accountId) throw new Error('R2 storage requires "accountId"')
      if (!config.bucket) throw new Error('R2 storage requires "bucket"')
      const accessKeyId = resolveEnvVars(config.accessKeyId)
      const secretAccessKey = resolveEnvVars(config.secretAccessKey)
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          'R2 storage requires accessKeyId and secretAccessKey.\n' +
            '  Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables, or\n' +
            '  create an R2 API token at https://dash.cloudflare.com/<account>/r2/api-tokens',
        )
      }
      try {
        const { createS3Provider } = await import('./providers/s3.js')
        return createS3Provider({
          endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
          bucket: config.bucket,
          accessKeyId,
          secretAccessKey,
          region: config.region,
        })
      } catch {
        throw new Error(
          'R2 storage requires @aws-sdk/client-s3 and @aws-sdk/lib-storage. ' +
            'Install them: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage',
        )
      }
    }
    default:
      throw new Error(`Unknown storage type: ${(config as StorageConfig).type}`)
  }
}

/**
 * Per-target init timeout — guards against SDKs that hang on unreachable
 * endpoints instead of surfacing the connection error. 10s is generous for
 * cold-start against real cloud storage and still fast enough that a
 * missing local emulator doesn't wedge the dev server for long.
 */
const TARGET_INIT_TIMEOUT_MS = 10000

export async function createTargetRegistry(
  targets: Record<string, TargetConfig>,
  siteDir: string,
): Promise<Map<string, StorageProvider>> {
  const registry = new Map<string, StorageProvider>()
  // Init targets in parallel — a slow/failing target must not serialize
  // behind the others. Each has its own timeout so a hang doesn't stall the
  // registry indefinitely.
  await Promise.all(
    Object.entries(targets).map(async ([name, config]) => {
      try {
        const initOne = async () => {
          const provider = await createStorageProvider(config.storage, siteDir, name)
          if ('init' in provider && typeof provider.init === 'function') {
            await (provider as StorageProvider & { init(): Promise<void> }).init()
          }
          return provider
        }
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`init timed out after ${TARGET_INIT_TIMEOUT_MS}ms`)),
            TARGET_INIT_TIMEOUT_MS,
          ),
        )
        const provider = await Promise.race([initOne(), timeout])
        registry.set(name, provider)
      } catch (err) {
        console.warn(`  Warning: target "${name}" failed to initialize: ${(err as Error).message}`)
      }
    }),
  )
  return registry
}
