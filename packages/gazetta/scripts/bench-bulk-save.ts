/**
 * Measures `POST /api/v1/saves` with a full batch (#1714, design-agent-access.md
 * Q46 "to be measured"), on the filesystem and on the MinIO emulator, against
 * the 5-second admin budget. Not run in CI; needs Docker for MinIO.
 *
 *   npx tsx packages/gazetta/scripts/bench-bulk-save.ts [items=200] [runs=3] [cold]
 *
 * Each run edits every page of a fresh site of `items` pages in one request,
 * so the time includes loading the site, every check, every write, the
 * revision and the per-item after-write steps.
 */
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DockerComposeEnvironment } from 'testcontainers'
import { createAdminApp } from '../src/admin-api/index.js'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { ensureHistoryBaseline } from '../src/history-recorder.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createS3Provider } from '../src/providers/s3.js'
import { computeSaveEtag } from '../src/save-etag.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'

const ITEMS = Number(process.argv[2] ?? 200)
const RUNS = Number(process.argv[3] ?? 3)
/** `cold` measures a site's first write, which also records history's baseline. */
const WARM = process.argv[4] !== 'cold'
const repoRoot = resolve(import.meta.dirname, '../../..')
const templatesDir = resolve(repoRoot, 'examples/starter/templates')
const tmpRoot = resolve(repoRoot, '.tmp/bench-bulk-save')

const pageOf = (title: string) => ({
  template: 'page-default',
  content: {},
  components: [{ id: 'c1', name: 'hero', template: 'hero', content: { title } }],
})

async function seed(storage: StorageProvider): Promise<void> {
  const writes = []
  for (let i = 0; i < ITEMS; i++) {
    writes.push(storage.writeFile(`pages/p${i}/page.json`, `${JSON.stringify(pageOf(`Page ${i}`), null, 2)}\n`))
  }
  await Promise.all(writes)
}

async function once(storage: StorageProvider): Promise<number> {
  await seed(storage)
  // A site the CMS has written to before already has history; the first
  // write's one-time baseline isn't part of a run's cost.
  if (WARM)
    await ensureHistoryBaseline({
      history: createHistoryProvider({ storage }),
      contentRoot: createContentRoot(storage, ''),
    })
  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true, publicStorage: false },
  }
  const manifest: SiteManifest = { name: 'bench', targets: targetConfigs }
  const app = createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir,
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  const items = await Promise.all(
    Array.from({ length: ITEMS }, async (_, i) => ({
      kind: 'page',
      name: `p${i}`,
      manifest: pageOf(`Page ${i} edited`),
      ifMatch: await computeSaveEtag({ ...pageOf(`Page ${i}`), route: `/p${i}` }),
    })),
  )
  const start = performance.now()
  const res = await app.request('/api/v1/saves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Gazetta-Run': 'bench' },
    body: JSON.stringify({ items }),
  })
  const ms = performance.now() - start
  if (res.status !== 200) throw new Error(`bulk save answered ${res.status}: ${await res.text()}`)
  return ms
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function measure(name: string, fresh: (run: number) => Promise<StorageProvider>) {
  const times: number[] = []
  for (let run = 0; run < RUNS; run++) times.push(await once(await fresh(run)))
  console.log(
    `${name}${WARM ? '' : ' (first write)'}: ${ITEMS} items, median ${median(times).toFixed(0)} ms (runs: ${times.map(t => t.toFixed(0)).join(', ')} ms)`,
  )
}

await rm(tmpRoot, { recursive: true, force: true })
await measure('filesystem', async run => {
  const dir = resolve(tmpRoot, `fs-${run}`)
  await mkdir(dir, { recursive: true })
  return createFilesystemProvider(dir)
})

const env = await new DockerComposeEnvironment(repoRoot, 'docker-compose.yml').up(['minio'])
try {
  const endpoint = `http://localhost:${env.getContainer('minio-1').getMappedPort(9000)}`
  await measure('s3 (MinIO)', async run => {
    const s3 = createS3Provider({
      endpoint,
      bucket: `bench-bulk-${Date.now()}-${run}`,
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      region: 'us-east-1',
    })
    await s3.init()
    return s3
  })
} finally {
  await env.down()
  await rm(tmpRoot, { recursive: true, force: true })
}
