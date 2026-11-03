/**
 * Public storage cut 4 (#1592, design-public-storage.md Q7): every path
 * that writes to a target leaves nothing under `.gazetta/` on a public
 * target except the folders the state folder registry marks safe there.
 * The forbidden set comes from `STATE_FOLDERS`, so a new unsafe folder is
 * covered without touching this test. A private target is the control:
 * it still gets history and dependency indices.
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { runHistoryRollback, runHistoryUndo } from '../src/cli/history.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createPublishSnapshot } from '../src/publish-snapshot.js'
import { publishToTarget } from '../src/publish-target.js'
import { STATE_FOLDERS, STATE_ROOT, type StateFolder } from '../src/state-folders.js'
import { scanTemplates } from '../src/templates-scan.js'
import type { SiteManifest, StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterProjectRoot, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'
import { tempDir } from './_helpers/temp.js'

const run = promisify(execFile)
const packageRoot = join(import.meta.dirname, '..')
const cli = join(packageRoot, 'dist/cli/index.js')

/** `.gazetta/` paths in the storage whose folder isn't safe on a public target. */
function unsafeStatePaths(paths: Iterable<string>): string[] {
  return [...paths].filter(path => {
    const parts = path.split('/')
    const at = parts.indexOf(STATE_ROOT)
    if (at === -1) return false
    const folder = parts[at + 1] as StateFolder
    return !(folder in STATE_FOLDERS && STATE_FOLDERS[folder].safeOnPublic)
  })
}

const statePaths = (storage: MemoryStorage) => [...storage.dump().keys()].filter(p => p.split('/').includes(STATE_ROOT))

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name)))
}

const publicConfig = (storage: StorageProvider): TargetConfig => ({ storage, type: 'esi', environment: 'production' })
const privateConfig = (storage: StorageProvider): TargetConfig => ({
  storage,
  type: 'esi',
  environment: 'staging',
  publicStorage: false,
})

describe('publishToTarget, as the CLI calls it', { timeout: 30_000 }, () => {
  async function publishTo(targetConfig: TargetConfig) {
    const manifest = await starterManifest()
    const sourceRoot = createContentRoot(createFilesystemProvider(starterTargetDir), '')
    const snapshot = await createPublishSnapshot({
      contentRoot: sourceRoot,
      manifest,
      templatesDir: starterTemplatesDir,
    })
    const targetStorage = targetConfig.storage as MemoryStorage
    const result = await publishToTarget({
      targetName: 'production',
      targetStorage,
      targetConfig,
      snapshot,
      sourceName: 'local',
      siteManifest: manifest,
      items: ['pages/home', 'fragments/header', 'fragments/footer'],
      itemRefs: [
        { kind: 'page', name: 'home' },
        { kind: 'fragment', name: 'header' },
        { kind: 'fragment', name: 'footer' },
      ],
      templateInfos: await scanTemplates(starterTemplatesDir, starterProjectRoot),
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    return targetStorage
  }

  it('writes only safe state folders to a public target', async () => {
    const storage = await publishTo(publicConfig(memoryStorage()))
    expect(unsafeStatePaths(storage.dump().keys())).toEqual([])
    expect(statePaths(storage)).toContain('.gazetta/publish-generation')
  })

  it('still writes history and dependency indices to a private target', async () => {
    const paths = statePaths(await publishTo(privateConfig(memoryStorage())))
    for (const folder of ['history', 'fragment-deps', 'deps-of']) {
      expect(paths.some(p => p.startsWith(`.gazetta/${folder}/`))).toBe(true)
    }
  })
})

describe('the admin publish routes', { timeout: 30_000 }, () => {
  let sourceDir: string

  beforeEach(async () => {
    sourceDir = tempDir(`public-write-paths-${process.pid}-${Date.now()}`)
    await cp(starterTargetDir, sourceDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true })
  })

  async function appWith(targetConfig: TargetConfig) {
    const local = createFilesystemProvider(sourceDir)
    const base = await starterManifest()
    const targetConfigs = {
      local: { storage: local, type: 'esi' as const, environment: 'local' as const, editable: true },
      production: targetConfig,
    }
    const manifest: SiteManifest = { ...base, targets: targetConfigs }
    return createAdminApp({
      source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
      siteDir: '/p',
      templatesDir: starterTemplatesDir,
      targets: new Map<string, StorageProvider>([
        ['local', local],
        ['production', targetConfig.storage],
      ]),
      targetConfigs,
      disableCacheStatsLogger: true,
    })
  }

  const publish = (route: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['pages/home', 'fragments/header'], targets: ['production'] }),
  })

  it.each(['/api/v1/publish', '/api/v1/publish/stream'])(
    '%s writes only safe state folders to a public target',
    async route => {
      const target = memoryStorage()
      const app = await appWith(publicConfig(target))
      const res = await app.request(route, publish(route))
      const body = await res.text()
      expect(res.status).toBe(200)
      expect(body).not.toContain('"success":false')
      expect(statePaths(target).length).toBeGreaterThan(0)
      expect(unsafeStatePaths(target.dump().keys())).toEqual([])
    },
  )

  it.each(['/api/v1/publish', '/api/v1/publish/stream'])('%s still writes history to a private target', async route => {
    const target = memoryStorage()
    const app = await appWith(privateConfig(target))
    await (await app.request(route, publish(route))).text()
    expect(statePaths(target).some(p => p.startsWith('.gazetta/history/'))).toBe(true)
  })

  it.each([
    ['undo', '/api/v1/history/undo?target=production', {}],
    ['restore', '/api/v1/history/restore?target=production&id=rev-1', {}],
  ])('%s on a public target is refused because history is off, and writes nothing', async (_, path, body) => {
    const target = memoryStorage()
    const app = await appWith(publicConfig(target))
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain(`History is off because \\"production\\"'s storage is public`)
    expect(statePaths(target)).toEqual([])
  })
})

describe('gazetta undo and rollback', () => {
  it.each([
    [
      'undo',
      (config: TargetConfig) => runHistoryUndo({ siteDir: '/p', targetName: 'production', config }, { yes: true }),
    ],
    [
      'rollback',
      (config: TargetConfig) =>
        runHistoryRollback({ siteDir: '/p', targetName: 'production', config }, 'rev-1', { yes: true }),
    ],
  ])('%s on a public target is refused because history is off, and writes nothing', async (_, command) => {
    const target = memoryStorage()
    await expect(command(publicConfig(target))).rejects.toThrow(
      `History is off because "production"'s storage is public`,
    )
    expect(statePaths(target)).toEqual([])
  })
})

describe('gazetta deploy', { timeout: 60_000 }, () => {
  let project: string
  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  it('writes no state to a public target', async () => {
    project = tempDir(`public-deploy-${process.pid}-${Date.now()}`)
    const site = join(project, 'sites/main')
    const prod = join(project, 'prod')
    await mkdir(site, { recursive: true })
    await mkdir(prod, { recursive: true })
    await writeFile(
      join(site, 'site.config.ts'),
      `import { filesystemStorage } from ${JSON.stringify(join(packageRoot, 'dist/index.js'))}
export default {
  name: 'main',
  targets: {
    production: {
      storage: filesystemStorage({ path: ${JSON.stringify(prod)} }),
      deploy: { name: 'noop', supports: ['static', 'esi', 'dynamic'], async execute() { return {} } },
    },
  },
}
`,
    )
    const { stdout } = await run(process.execPath, [cli, 'deploy', 'production'], { cwd: project })
    expect(stdout).toContain('Deploy complete')
    expect(unsafeStatePaths(await filesUnder(prod))).toEqual([])
  })
})
