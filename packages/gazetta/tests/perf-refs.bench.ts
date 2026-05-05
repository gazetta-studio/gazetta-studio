/**
 * Performance benchmarks for refs-scan operations — both the legacy
 * walk-on-demand and the new sidecar index. Run as a guard against
 * future regressions and to make the perf claims falsifiable.
 *
 * Three backends:
 *   - Filesystem (local) — baseline
 *   - S3-compatible (MinIO via testcontainers — proxies cloud cost)
 *   - Azure Blob (Azurite via testcontainers)
 *
 * Three N-values: 100 / 500 / 1000 pages.
 *
 * Per scenario, the benches measure:
 *   - findAssetRefs (LEGACY walk): full site walk for one asset's refs.
 *     The cost shape that motivated building the sidecar index.
 *   - loadSite: full site load — the dominant cost inside findAssetRefs.
 *   - readRefsForAsset (NEW sidecar lookup): one readDir against the
 *     asset's `.gazetta/asset-refs/{asset}/` dir. The fast path the
 *     sidecar index buys us.
 *   - applyItemRefsDiff (NEW save-side cost): one save's per-asset
 *     sidecar write/delete pair. The cost we trade for the read win.
 *   - writeFile (single .refs/X.json): hypothetical aggregate-JSON write,
 *     kept for comparison against the per-edge sidecar shape.
 *
 * Why module-scope setup (top-level await) instead of beforeAll:
 *   Vitest's bench runner silently drops `beforeAll`/`afterAll` hooks
 *   (see vitest dist/chunks/test.*.js → runBenchmarkSuite — only iterates
 *   task.meta?.benchmark tasks and subsuites). Module-scope async setup
 *   IS awaited before benches run, so we use that.
 *
 * Decision rule (set when building the index): findAssetRefs at N=1000
 * crosses the 5s admin SLA on real cloud; sidecar lookup must stay
 * sub-second at N=1000 to clear the bar.
 */
import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { bench, describe } from 'vitest'
import { DockerComposeEnvironment, type StartedDockerComposeEnvironment } from 'testcontainers'
import { findAssetRefs } from '../src/assets/find-refs.js'
import { applyAssetRefsDiff, readRefsForAsset } from '../src/assets/asset-deps.js'
import type { ItemRef } from '../src/dep-sidecars.js'
import { createContentRoot } from '../src/content-root.js'
import { createAzureBlobProvider } from '../src/providers/azure-blob.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createS3Provider } from '../src/providers/s3.js'
import { rebuildAssetRefsIndex } from '../src/publish-rendered.js'
import { loadSite } from '../src/site-loader.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { buildSyntheticSite, SYNTHETIC_ASSETS } from './_helpers/synthetic-site.js'

// Synthetic manifest for `loadSite` calls below. Cut 8 of the TS-config
// migration removed YAML loading from site-loader; benches don't need a
// real config since they exercise content discovery, not config evaluation.
const syntheticManifest: SiteManifest = { name: 'Synthetic Site', locale: 'en' }

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
  let storage: StorageProvider
  if (backend === 'filesystem') {
    const dir = resolve(tmpRoot, `fs-${id}-${N}`)
    await rm(dir, { recursive: true, force: true })
    storage = createFilesystemProvider(dir)
  } else if (backend === 's3-minio') {
    const bucket = `perf-${id}-${N}`
    const s3 = createS3Provider({
      endpoint: minioEndpoint,
      bucket,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      region: 'us-east-1',
    })
    await s3.init()
    storage = s3
  } else {
    // azure-azurite
    const container = `perf-${id}-${N}`
    const az = createAzureBlobProvider({
      connectionString: azuriteConnectionString,
      container,
    })
    await az.init()
    storage = az
  }
  await buildSyntheticSite(storage, { pageCount: N, contentRoot: '' })
  // Populate the sidecar index — this is what `gazetta publish` writes
  // at end-of-publish and what `gazetta assets reindex` rebuilds. The
  // sidecar-lookup bench reads from this populated state.
  const site = await loadSite({ contentRoot: createContentRoot(storage, ''), manifest: syntheticManifest })
  await rebuildAssetRefsIndex(site, storage, '')
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

// One describe per (backend × N). Per-scenario benches:
//
// LEGACY walk path:
//   - findAssetRefs (single asset) — full site walk
//   - loadSite (full site read) — dominant cost inside the walk
//
// NEW sidecar path:
//   - readRefsForAsset (sidecar lookup) — single readDir
//   - applyItemRefsDiff (sidecar write per save) — N small per-edge writes
//
// Comparison anchor:
//   - writeFile (single .refs/X.json) — aggregate-JSON write cost,
//     kept so reviewers can see the per-edge-vs-aggregate write tradeoff
for (const s of scenarios) {
  describe(`${s.backend} @ N=${s.N}`, () => {
    const contentRoot = createContentRoot(s.storage, s.siteDir)

    // ---- LEGACY walk path ------------------------------------------------
    bench(
      'findAssetRefs (single asset) [walk]',
      async () => {
        await findAssetRefs({ storage: s.storage, siteDir: s.siteDir, assetName: SYNTHETIC_ASSETS[0]! })
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )

    bench(
      'loadSite (full site read)',
      async () => {
        await loadSite({ contentRoot, manifest: syntheticManifest })
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )

    // ---- NEW sidecar path ------------------------------------------------
    bench(
      'readRefsForAsset (single asset) [sidecar lookup]',
      async () => {
        await readRefsForAsset(contentRoot, SYNTHETIC_ASSETS[0]!)
      },
      { time: 0, iterations: 5, warmupIterations: 1, throws: true },
    )

    bench(
      'applyAssetRefsDiff (3 assets added) [sidecar save]',
      async () => {
        // Simulate the save-side cost: a save adds 3 new asset refs to
        // an item (removing 0). Three concurrent zero-byte writes to
        // separate asset dirs. Use a fresh item name per iteration so
        // we measure actual writes, not idempotent no-ops. Item names
        // can't contain dots — use base36 (digits + lowercase letters).
        const id = Math.random().toString(36).slice(2)
        const item: ItemRef = { source: 'page', name: `bench-${id}` }
        await applyAssetRefsDiff(
          contentRoot,
          item,
          new Set(),
          new Set([SYNTHETIC_ASSETS[0]!, SYNTHETIC_ASSETS[1]!, SYNTHETIC_ASSETS[2]!]),
        )
      },
      { time: 0, iterations: 5, warmupIterations: 1, throws: true },
    )

    // ---- Aggregate-JSON shape (rejected alternative; kept for compare) ---
    bench(
      'writeFile (single aggregate .refs.json)',
      async () => {
        const id = Math.random().toString(36).slice(2)
        const body = JSON.stringify({ asset: 'hero', refs: [], updatedAt: new Date().toISOString() })
        await s.storage.writeFile(`assets/.refs/bench-${id}.json`, body)
      },
      { time: 0, iterations: 5, warmupIterations: 1, throws: true },
    )
  })
}
