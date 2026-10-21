/**
 * `gazetta publish` records a history revision on the target (#1079):
 * after a CLI publish, `gazetta history` lists a `publish` revision and
 * `gazetta undo` restores the pre-publish state. Before the fix the CLI
 * path recorded nothing, so CLI publishes were invisible to history and
 * could not be undone.
 *
 * Spawns the CLI against a temp copy of the starter site (filesystem
 * `local` target — no credentials or containers needed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, rm, readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

function runCli(cwd: string, args: string[]): Promise<{ output: string; code: number }> {
  return new Promise(done => {
    const child = spawn(tsxBin, [cliPath, ...args], {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))
    child.on('close', code => done({ output, code: code ?? 0 }))
  })
}

describe('gazetta publish — history recording (#1079)', { timeout: 180000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-history-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('lists a publish revision after a CLI publish, and undo restores the pre-publish state', async () => {
    const pagePath = resolve(projectDir, 'sites/main/targets/local/pages/home/page.json')
    const before = await readFile(pagePath, 'utf8')

    // Change the source page so the second publish has something to record.
    const edited = before.replace(/"title"\s*:\s*"[^"]*"/, '"title": "Edited by #1079 test"')
    expect(edited).not.toBe(before)

    // Baseline state: publish the original first, then the edit.
    let res = await runCli(projectDir, ['publish', 'local', 'sites/main', '--force'])
    expect(res.code).toBe(0)
    await (await import('node:fs/promises')).writeFile(pagePath, edited)
    res = await runCli(projectDir, ['publish', 'local', 'sites/main', '--force'])
    expect(res.code).toBe(0)

    // History lists publish revisions — before the fix there were none.
    res = await runCli(projectDir, ['history', 'local', 'sites/main'])
    expect(res.code).toBe(0)
    expect(res.output).toContain('publish')

    // Undo restores the pre-publish page state.
    res = await runCli(projectDir, ['undo', 'local', 'sites/main', '--yes'])
    expect(res.code).toBe(0)
    const restored = await readFile(pagePath, 'utf8')
    expect(restored).toBe(before)
  })
})
