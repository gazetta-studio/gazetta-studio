/**
 * Performance benchmarks for refs-scan operations.
 *
 * Why: deciding whether the v1 walk-on-demand for asset refs is fast
 * enough, or whether we need a persistent index. Refs-index has real
 * complexity (drift recovery, optimistic concurrency for multi-instance),
 * so we want measured numbers before committing.
 *
 * Three backends:
 *   - Filesystem (local) — baseline
 *   - S3-compatible (MinIO via testcontainers — proxies cloud cost)
 *   - Azure Blob (Azurite via testcontainers)
 *
 * Three N-values: 100 / 500 / 1000 pages.
 *
 * Three scenarios per (backend, N):
 *   - findAssetRefs: walk site for refs to one specific asset
 *   - loadSite: full site load (the dominant cost inside findAssetRefs)
 *   - writeFile: single .refs/X.json write (hypothetical incremental cost)
 *
 * Why module-scope setup (top-level await) instead of beforeAll:
 *   Vitest's bench runner silently drops `beforeAll`/`afterAll` hooks
 *   (see vitest dist/chunks/test.*.js → runBenchmarkSuite — only iterates
 *   task.meta?.benchmark tasks and subsuites). Module-scope async setup
 *   IS awaited before benches run, so we use that.
 *
 * Decision rule (set in advance):
 *   - findAssetRefs at N=1000 < 1s on cloud → defer the index
 *   - 1-10s → real problem at scale; build the index for v1.5
 *   - >10s → must address in v1
 */
import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { bench, describe } from 'vitest'
import { DockerComposeEnvironment, type StartedDockerComposeEnvironment } from 'testcontainers'
import { findAssetRefs } from '../src/assets/find-refs.js'
import { createContentRoot } from '../src/content-root.js'
import { createAzureBlobProvider } from '../src/providers/azure-blob.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createS3Provider } from '../src/providers/s3.js'
import { loadSite } from '../src/site-loader.js'
import type { StorageProvider } from '../src/types.js'
import { buildSyntheticSite, SYNTHETIC_ASSETS } from './_helpers/synthetic-site.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const tmpRoot = resolve(repoRoot, '.tmp/perf-refs')
const composeDir = repoRoot

const PAGE_COUNTS = [100, 500, 1000] as const

// Module-scope setup. Bench runner doesn't honor beforeAll, but module
// import IS awaited — we kick off the docker setup and synthetic-site
// builds here, then each bench body just reuses the resolved storage.
type BackendName = 'filesystem' | 's3-minio' | 'azure-azurite'

interface PreparedScenario {
  backend: BackendName
  N: number
  storage: StorageProvider
  siteDir: string
}

const env: StartedDockerComposeEnvironment = await new DockerComposeEnvironment(composeDir, 'docker-compose.yml').up()
const minio = env.getContainer('minio-1')
const minioEndpoint = `http://localhost:${minio.getMappedPort(9000)}`

const azurite = env.getContainer('azurite-1')
const blobPort = azurite.getMappedPort(10000)
const queuePort = azurite.getMappedPort(10001)
const tablePort = azurite.getMappedPort(10002)
const accountName = 'devstoreaccount1'
const accountKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
const azuriteConnectionString =
  `DefaultEndpointsProtocol=http;AccountName=${accountName};AccountKey=${accountKey};` +
  `BlobEndpoint=http://127.0.0.1:${blobPort}/${accountName};` +
  `QueueEndpoint=http://127.0.0.1:${queuePort}/${accountName};` +
  `TableEndpoint=http://127.0.0.1:${tablePort}/${accountName}`

async function setup(backend: BackendName, N: number): Promise<PreparedScenario> {
  const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (backend === 'filesystem') {
    const dir = resolve(tmpRoot, `fs-${id}-${N}`)
    await rm(dir, { recursive: true, force: true })
    const storage = createFilesystemProvider(dir)
    await buildSyntheticSite(storage, { pageCount: N, contentRoot: '' })
    return { backend, N, storage, siteDir: '' }
  }
  if (backend === 's3-minio') {
    const bucket = `perf-${id}-${N}`
    const storage = createS3Provider({
      endpoint: minioEndpoint,
      bucket,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      region: 'us-east-1',
    })
    await storage.init()
    await buildSyntheticSite(storage, { pageCount: N, contentRoot: '' })
    return { backend, N, storage, siteDir: '' }
  }
  // azure-azurite
  const container = `perf-${id}-${N}`
  const storage = createAzureBlobProvider({
    connectionString: azuriteConnectionString,
    container,
  })
  await storage.init()
  await buildSyntheticSite(storage, { pageCount: N, contentRoot: '' })
  return { backend, N, storage, siteDir: '' }
}

// Build all 9 scenarios up front. Sequential (cheap-to-expensive) so
// docker pulls don't get hammered concurrently.
const scenarios: PreparedScenario[] = []
for (const backend of ['filesystem', 's3-minio', 'azure-azurite'] as const) {
  for (const N of PAGE_COUNTS) {
    scenarios.push(await setup(backend, N))
  }
}

// One describe per (backend × N), each with three benches.
for (const s of scenarios) {
  describe(`${s.backend} @ N=${s.N}`, () => {
    bench(
      'findAssetRefs (single asset)',
      async () => {
        await findAssetRefs({ storage: s.storage, siteDir: s.siteDir, assetName: SYNTHETIC_ASSETS[0]! })
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )

    bench(
      'loadSite (full site read)',
      async () => {
        await loadSite({ contentRoot: createContentRoot(s.storage, s.siteDir) })
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )

    bench(
      'writeFile (single .refs/X.json)',
      async () => {
        const body = JSON.stringify({ asset: 'hero', refs: [], updatedAt: new Date().toISOString() })
        await s.storage.writeFile(`assets/.refs/bench-${Math.random()}.json`, body)
      },
      { time: 0, iterations: 5, warmupIterations: 1, throws: true },
    )
  })
}
