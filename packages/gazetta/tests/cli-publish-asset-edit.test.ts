/**
 * #1334: editing an asset republishes the items that use it. A page's hash
 * includes the assets it references, directly or through a fragment it bakes
 * in, so `gazetta publish` re-renders them and copies the new asset manifest,
 * while pages that don't use the asset stay skipped.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tempDir } from './_helpers/temp.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { listSidecars } from '../src/sidecars.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

function runCli(cwd: string, args: string[]): Promise<{ output: string; code: number }> {
  return new Promise((done, reject) => {
    const child = spawn(tsxBin, [cliPath, ...args], {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', data => (output += data.toString()))
    child.stderr?.on('data', data => (output += data.toString()))
    child.on('error', reject)
    child.on('close', code => done({ output, code: code ?? 1 }))
  })
}

async function editJson(path: string, edit: (json: any) => void) {
  const json = JSON.parse(await readFile(path, 'utf8'))
  edit(json)
  await writeFile(path, JSON.stringify(json, null, 2))
}

describe('gazetta publish after an asset edit (#1334)', { timeout: 180000 }, () => {
  it('republishes the pages that use the asset, directly or through a fragment, and skips the rest', async () => {
    const projectDir = tempDir(`cli-asset-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await cp(starterDir, projectDir, {
        recursive: true,
        filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
      })
      const siteDir = resolve(projectDir, 'sites/main')
      const sourceDir = resolve(siteDir, 'targets/local')
      // A fragment that shows the asset, and a page that uses it only through that fragment.
      const demo = JSON.parse(await readFile(resolve(sourceDir, 'pages/asset-demo/page.json'), 'utf8'))
      const hero = demo.components.find((c: any) => typeof c === 'object' && c.name === 'hero')
      await mkdir(resolve(sourceDir, 'fragments/promo'), { recursive: true })
      await writeFile(
        resolve(sourceDir, 'fragments/promo/fragment.json'),
        JSON.stringify({ template: hero.template, content: hero.content }),
      )
      await mkdir(resolve(sourceDir, 'pages/promo'), { recursive: true })
      await writeFile(
        resolve(sourceDir, 'pages/promo/page.json'),
        JSON.stringify({ template: demo.template, route: '/promo', components: ['@promo'] }),
      )

      const targetDir = resolve(siteDir, 'dist/staging')
      const target = createFilesystemProvider(targetDir)
      const baseline = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
      expect(baseline.code, baseline.output).toBe(0)
      const before = await listSidecars(target, 'pages')

      await editJson(resolve(sourceDir, 'assets/test-pattern.asset.json'), j => {
        j.alt = 'A new description of the test pattern'
      })
      const published = await runCli(projectDir, ['publish', 'staging', 'sites/main'])
      expect(published.code, published.output).toBe(0)
      const after = await listSidecars(target, 'pages')

      for (const page of ['asset-demo', 'promo']) {
        expect(after.get(page)!.hash, page).not.toBe(before.get(page)!.hash)
        const html = await readFile(resolve(targetDir, page, 'index.html'), 'utf8')
        expect(html, page).toContain('A new description of the test pattern')
      }
      expect(after.get('home')!.hash).toBe(before.get('home')!.hash)
      expect(after.get('home')!.pub!.lastPublished).toBe(before.get('home')!.pub!.lastPublished)
      const copied = JSON.parse(await readFile(resolve(targetDir, 'assets/test-pattern.asset.json'), 'utf8'))
      expect(copied.alt).toBe('A new description of the test pattern')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it("a new language version of an asset reaches that language's pages", async () => {
    const projectDir = tempDir(`cli-asset-locale-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await cp(starterDir, projectDir, {
        recursive: true,
        filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
      })
      const siteDir = resolve(projectDir, 'sites/main')
      const sourceDir = resolve(siteDir, 'targets/local')
      const demoDir = resolve(sourceDir, 'pages/asset-demo')
      await writeFile(resolve(demoDir, 'page.fr.json'), await readFile(resolve(demoDir, 'page.json'), 'utf8'))

      const targetDir = resolve(siteDir, 'dist/staging')
      const baseline = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
      expect(baseline.code, baseline.output).toBe(0)

      // A French version with its own bytes, as the locale-bytes upload writes it.
      const assets = resolve(sourceDir, 'assets')
      await cp(resolve(assets, 'test-pattern-2092f9b7.jpg'), resolve(assets, 'test-pattern-0badc0de.fr.jpg'))
      await writeFile(
        resolve(assets, 'test-pattern.asset.fr.json'),
        JSON.stringify({
          version: 1,
          name: 'test-pattern',
          hash: '0badc0de',
          size: 4544,
          mime: 'image/jpeg',
          width: 1200,
          height: 600,
          variants: [],
        }),
      )
      const published = await runCli(projectDir, ['publish', 'staging', 'sites/main'])
      expect(published.code, published.output).toBe(0)

      const fr = await readFile(resolve(targetDir, 'fr/asset-demo/index.html'), 'utf8')
      expect(fr).toContain('test-pattern-0badc0de.fr.jpg')
      const en = await readFile(resolve(targetDir, 'asset-demo/index.html'), 'utf8')
      expect(en).not.toContain('test-pattern-0badc0de.fr.jpg')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
