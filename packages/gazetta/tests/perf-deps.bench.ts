/**
 * Performance benchmarks for fragment-deps + compare paths introduced
 * in steps 13a/b/c. Companion to perf-refs.bench.ts (which covers the
 * asset-refs surface).
 *
 * Three backends:
 *   - Filesystem (local) — baseline
 *   - S3-compatible (MinIO via testcontainers — proxies cloud cost)
 *   - Azure Blob (Azurite via testcontainers)
 *
 * Three N-values: 100 / 500 / 1000 pages.
 *
 * Per scenario, the benches measure:
 *   - findFragmentDependents (LEGACY walk): walk every manifest looking
 *     for the fragment ref. The cost shape that motivated the per-edge
 *     reverse index.
 *   - findDependentsFromSidecars (NEW): one readDir against
 *     `.gazetta/fragment-deps/{frag}/`, plus BFS for transitive
 *     fragment→fragment refs. Tree-badge query path.
 *   - rebuildDepIndex(FRAGMENT_DEPS) [cold]: full source rebuild — the
 *     cost paid on first /api/dependents query after a fresh dev server
 *     starts. Memoized in production, but the cold path matters.
 *   - compareTargets [post-13a]: end-to-end compare with always-rehash.
 *     13a removed the source-side hash cache as a correctness fix; this
 *     bench guards against an unmeasured perf regression at scale.
 *   - hashManifest × N: decomposition — how much of compareTargets time
 *     is the hashing itself vs site loading + sidecar listing.
 *
 * Why module-scope setup (top-level await) instead of beforeAll:
 *   See perf-refs.bench.ts for the rationale — vitest's bench runner
 *   silently drops beforeAll/afterAll hooks.
 *
 * Decision rules (set when building the new sidecar shape):
 *   - findDependentsFromSidecars at N=1000 must stay sub-second on real
 *     cloud (tree badges fire on every fragment click).
 *   - compareTargets at N=1000 must stay under the 5s admin SLA.
 */
import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { bench, describe } from 'vitest'
import { DockerComposeEnvironment, type StartedDockerComposeEnvironment } from 'testcontainers'
import { findDependentsFromSidecars, findFragmentDependents } from '../src/publish.js'
import { compareTargets } from '../src/compare.js'
import { createContentRoot } from '../src/content-root.js'
import { createAzureBlobProvider } from '../src/providers/azure-blob.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createS3Provider } from '../src/providers/s3.js'
import { rebuildDepIndex } from '../src/publish-rendered.js'
import { FRAGMENT_DEPS } from '../src/fragment-deps.js'
import { loadSite } from '../src/site-loader.js'
import { hashManifest } from '../src/hash.js'
import type { StorageProvider } from '../src/types.js'
import type { TemplateInfo } from '../src/templates-scan.js'
import { buildSyntheticSite } from './_helpers/synthetic-site.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const tmpRoot = resolve(repoRoot, '.tmp/perf-deps')
const composeDir = repoRoot

const PAGE_COUNTS = [100, 500, 1000] as const

type BackendName = 'filesystem' | 's3-minio' | 'azure-azurite'

interface PreparedScenario {
  backend: BackendName
  N: number
  storage: StorageProvider
  siteDir: string
}

// Stub template scanner — synthetic pages declare templates that don't
// exist on disk (`page-default`, `card`, `fragment-default`). Returning
// pre-baked TemplateInfo entries lets compareTargets run without a
// real template tree, which is what we want for benchmarking the
// hashing/sidecar paths in isolation.
const STUB_TEMPLATES: TemplateInfo[] = [
  { name: 'page-default', hash: 'aaaaaaaa', valid: true, errors: [], files: [] },
  { name: 'card', hash: 'bbbbbbbb', valid: true, errors: [], files: [] },
  { name: 'fragment-default', hash: 'cccccccc', valid: true, errors: [], files: [] },
]
const stubScanTemplates = async (): Promise<TemplateInfo[]> => STUB_TEMPLATES

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
    const container = `perf-${id}-${N}`
    const az = createAzureBlobProvider({
      connectionString: azuriteConnectionString,
      container,
    })
    await az.init()
    storage = az
  }
  await buildSyntheticSite(storage, { pageCount: N, contentRoot: '' })
  // Populate the fragment-deps index — this is what `gazetta publish`
  // writes at end-of-publish via publishDepIndices, and what the admin's
  // memoized `ensureFragmentDepsIndex` rebuilds on first /api/dependents
  // for a fresh dev server.
  const site = await loadSite({ contentRoot: createContentRoot(storage, '') })
  await rebuildDepIndex(FRAGMENT_DEPS, site, storage, '')
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

for (const s of scenarios) {
  describe(`${s.backend} @ N=${s.N}`, () => {
    const contentRoot = createContentRoot(s.storage, s.siteDir)

    // ---- LEGACY walk path ------------------------------------------------
    bench(
      'findFragmentDependents (header) [walk]',
      async () => {
        await findFragmentDependents(contentRoot, 'header')
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )

    // ---- NEW reverse-sidecar path ----------------------------------------
    bench(
      'findDependentsFromSidecars (header) [sidecar BFS]',
      async () => {
        await findDependentsFromSidecars(contentRoot, { fragment: 'header' })
      },
      { time: 0, iterations: 5, warmupIterations: 1, throws: true },
    )

    // ---- Cold rebuild — first-query cost on a fresh dev server -----------
    // Wipes the fragment-deps index, then rebuilds from in-memory site.
    // Each iteration pays the full rebuild cost (low iteration count
    // because each tear-down + rebuild is N writes).
    bench(
      'rebuildDepIndex(FRAGMENT_DEPS) [cold]',
      async () => {
        await s.storage.rm('.gazetta/fragment-deps').catch(() => {
          /* missing dir = nothing to wipe */
        })
        const site = await loadSite({ contentRoot })
        await rebuildDepIndex(FRAGMENT_DEPS, site, s.storage, s.siteDir)
      },
      { time: 0, iterations: 2, warmupIterations: 0, throws: true },
    )

    // ---- compareTargets — post-13a always-rehash path --------------------
    // 13a removed the source-side hash cache (it was returning stale
    // hashes after template edits in dynamic mode). compare now always
    // re-hashes from in-memory manifests. This bench measures what
    // that costs end-to-end at scale — guards against an unmeasured
    // regression. The 5s admin SLA is the bar.
    bench(
      'compareTargets [post-13a always-rehash]',
      async () => {
        await compareTargets({
          sourceRoot: contentRoot,
          target: s.storage,
          templatesDir: '/dev/null',
          projectRoot: '/dev/null',
          scanTemplates: stubScanTemplates,
        })
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )

    // ---- hashManifest × N — decomposition --------------------------------
    // Loads the site once, hashes every page + fragment manifest. The
    // delta vs compareTargets is the listSidecars + bookkeeping cost.
    bench(
      'hashManifest × N (loadSite + hash all)',
      async () => {
        const site = await loadSite({ contentRoot })
        const templateHashes = new Map(STUB_TEMPLATES.map(t => [t.name, t.hash]))
        for (const [, frag] of site.fragments) hashManifest(frag, { templateHashes })
        for (const [, page] of site.pages) hashManifest(page, { templateHashes })
      },
      { time: 0, iterations: 3, warmupIterations: 1, throws: true },
    )
  })
}
