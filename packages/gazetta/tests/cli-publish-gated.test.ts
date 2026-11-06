/**
 * `gazetta publish <gated-target>` (design-review-workflow.md lock 6,
 * review workflow cut 12, #1787): a CLI run has no signed-in user, so
 * it can't request a publish. It exits non-zero with lock 6's message
 * and writes nothing, to the target or to the source.
 *
 * Spawns the CLI against a temp copy of the starter with two filesystem
 * targets, the second requiring publish approval.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

const GATED_CONFIG = `import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Starter',
  version: '1.0.0',
  systemPages: ['404'],
  targets: {
    local: {
      storage: filesystemStorage({ path: './targets/local' }),
      publicStorage: false,
    },
    production: {
      storage: filesystemStorage({ path: './targets/production' }),
      publicStorage: false,
      environment: 'production',
      requiresPublishApproval: true,
    },
  },
})
`

async function snapshotTree(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const lines: string[] = []
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) lines.push(...(await snapshotTree(join(dir, e.name), rel)))
    else
      lines.push(
        `${rel}:${createHash('sha1')
          .update(await readFile(join(dir, e.name)))
          .digest('hex')}`,
      )
  }
  return lines.sort()
}

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

describe('gazetta publish to a target that requires approval', { timeout: 120000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-gated-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
    await writeFile(resolve(projectDir, 'sites/main/site.config.ts'), GATED_CONFIG)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('exits non-zero with the approval message and leaves the target and the source untouched', async () => {
    const targets = join(projectDir, 'sites/main/targets')
    const before = await snapshotTree(targets)

    const res = await runCli(projectDir, ['publish', 'production'])

    expect(res.code).toBe(1)
    expect(res.output).toContain('production requires publish approval — request it from the admin.')
    expect(await snapshotTree(targets)).toEqual(before)
  })
})
