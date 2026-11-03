/**
 * The site.config.ts `gazetta init` writes declares `publicStorage` on
 * every target (design-public-storage.md Q6), so a new site keeps
 * history on its editing target and validates with no public-storage
 * issue.
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { afterEach, describe, expect, it } from 'vitest'
import { isEditable, isPublicStorage, type TargetConfig } from '../src/types.js'
import { publicStorageConfig } from '../src/validation/validators/public-storage-config.js'
import { createContentRoot } from '../src/content-root.js'
import type { Site } from '../src/site-loader.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('cli-init-public-storage-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('gazetta init site.config.ts', () => {
  it('sets publicStorage on every target and validates clean', { timeout: 120000 }, async () => {
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir} --no-install`, {
      stdio: 'pipe',
    })
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { gazetta: resolve(import.meta.dirname, '../src/index.ts') },
    })
    const config = (await jiti.import(join(testDir, 'sites/main/site.config.ts'), { default: true })) as {
      targets: Record<string, TargetConfig>
    }
    const targets = Object.entries(config.targets)
    expect(targets.length).toBeGreaterThan(0)
    for (const [name, target] of targets) {
      expect(typeof target.publicStorage, name).toBe('boolean')
    }
    // The scaffolded editing target stays private and editable.
    expect(isPublicStorage(config.targets.local)).toBe(false)
    expect(isEditable(config.targets.local)).toBe(true)

    const storage = memoryStorage()
    const site = {
      manifest: { name: 'init', targets: config.targets },
      contentRoot: createContentRoot(storage, ''),
      storage,
    } as unknown as Site
    const issues = await publicStorageConfig.validate({
      stage: 'cli',
      site,
      contentRoot: site.contentRoot,
      storage,
      scope: { kind: 'cli' },
    })
    expect(issues).toEqual([])
  })

  it('writes a staging target next to the editing target', { timeout: 120000 }, async () => {
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir} --no-install`, {
      stdio: 'pipe',
    })
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { gazetta: resolve(import.meta.dirname, '../src/index.ts') },
    })
    const config = (await jiti.import(join(testDir, 'sites/main/site.config.ts'), { default: true })) as {
      targets: Record<string, TargetConfig>
    }
    expect(Object.keys(config.targets).sort()).toEqual(['local', 'staging'])
    const staging = config.targets.staging
    // A first publish can go to staging and `gazetta serve staging` shows it.
    expect(staging.storage.kind).toBe('filesystem')
    expect(staging.environment).toBe('staging')
    // Served by `gazetta serve`, which never serves `.gazetta/`, so the
    // target keeps history while staying private.
    expect(isPublicStorage(staging)).toBe(false)
    // Only the editing target is editable.
    expect(isEditable(staging)).toBe(false)
    const text = await readFile(join(testDir, 'sites/main/site.config.ts'), 'utf-8')
    expect(text).toContain('Served by `gazetta serve`')
  })
})

describe('gazetta init package.json', () => {
  it("depends on a caret range of the CLI's own version, not '*'", { timeout: 120000 }, async () => {
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir} --no-install`, {
      stdio: 'pipe',
    })
    const pkg = JSON.parse(await readFile(join(testDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>
    }
    const cliPkg = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf-8')) as {
      version: string
    }
    // A stable CLI version becomes a caret range; a prerelease pins to itself.
    const expected = cliPkg.version.includes('-') ? cliPkg.version : `^${cliPkg.version}`
    expect(pkg.dependencies.gazetta).toBe(expected)
  })
})

describe('gazetta init --no-install', () => {
  const binDir = tempDir('cli-init-fake-npm-' + Date.now())
  const marker = join(binDir, 'npm-ran')
  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true })
  })

  /** Runs init with a fake `npm` first on PATH that only records it ran. */
  async function initWithFakeNpm(extra: string[]) {
    await mkdir(binDir, { recursive: true })
    const npm = join(binDir, 'npm')
    await writeFile(npm, `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n`)
    await chmod(npm, 0o755)
    return spawnSync('node', [resolve(import.meta.dirname, '../dist/cli/index.js'), 'init', testDir, ...extra], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
  }

  it('writes the project, runs no npm, and says to run npm install', { timeout: 120000 }, async () => {
    const res = await initWithFakeNpm(['--no-install'])
    expect(res.status, res.stderr).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(testDir, 'sites/main/site.config.ts'))).toBe(true)
    expect(existsSync(join(testDir, 'package.json'))).toBe(true)
    expect(res.stdout + res.stderr).toContain('npm install && npx gazetta dev')
  })

  it('runs npm install without the flag', { timeout: 120000 }, async () => {
    const res = await initWithFakeNpm([])
    expect(res.status, res.stderr).toBe(0)
    expect(await readFile(marker, 'utf-8')).toContain('install')
  })
})
