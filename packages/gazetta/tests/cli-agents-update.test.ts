/**
 * `gazetta agents update` and the `gazetta dev` hint, run as the CLI
 * (design-agent-access.md Q33, #1735).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './_helpers/temp.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'packages/gazetta/package.json'), 'utf-8')) as {
  version: string
}
const section = (v: string) =>
  `<!-- gazetta:agents start version=${v} -->\n## Gazetta\nOld text.\n<!-- gazetta:agents end -->\n`

const cleanup: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGTERM')
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

const run = (cwd: string, args: string[]) =>
  spawnSync(tsxBin, [cliPath, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, CI: 'true' } })

describe('gazetta agents update', () => {
  it('updates an older section, then reports it current', async () => {
    const project = tempDir(`cli-agents-${Date.now()}`)
    cleanup.push(project)
    await cp(resolve(repoRoot, 'examples/starter'), project, { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), `# Ours\n\n${section('0.0.1')}\n## After\n`)

    const first = run(join(project, 'sites', 'main'), ['agents', 'update'])
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain(`updated Gazetta's section from 0.0.1 to ${version}`)
    const text = await readFile(join(project, 'AGENTS.md'), 'utf-8')
    expect(text.startsWith('# Ours\n\n')).toBe(true)
    expect(text.endsWith('\n## After\n')).toBe(true)
    expect(text).toContain(`<!-- gazetta:agents start version=${version} -->`)

    const second = run(project, ['agents', 'update'])
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('already current')
    expect(await readFile(join(project, 'AGENTS.md'), 'utf-8')).toBe(text)
  }, 60_000)

  it('exits 2 outside a project, and on a usage error', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'no-project-'))
    cleanup.push(outside)
    const res = run(outside, ['agents', 'update'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('no Gazetta project here')
    expect(run(outside, ['agents']).status).toBe(2)
  }, 60_000)
})

describe('the gazetta dev hint', () => {
  const startDev = async (agentsMd: string) => {
    const project = tempDir(`cli-agents-dev-${Date.now()}-${Math.random()}`)
    cleanup.push(project)
    await cp(resolve(repoRoot, 'examples/starter'), project, { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), agentsMd)
    const port = String(5200 + Math.floor(Math.random() * 100))
    const dev = spawn(tsxBin, [cliPath, 'dev', '--host', '127.0.0.1', '-p', port], {
      cwd: project,
      env: { ...process.env, CI: 'true' },
    })
    children.push(dev)
    let out = ''
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no startup banner:\n${out}`)), 60_000)
      const read = (d: Buffer) => {
        out += d
        if (out.includes('Frags')) {
          clearTimeout(timer)
          setTimeout(done, 200) // the hint is printed right after the Frags line
        }
      }
      dev.stdout.on('data', read)
      dev.stderr.on('data', read)
    })
    return out
  }

  it('prints the hint for an older section, and nothing for a current one', async () => {
    expect(await startDev(section('0.0.1'))).toContain(
      "AGENTS.md has Gazetta's agent section from 0.0.1; run `gazetta agents update`.",
    )
    expect(await startDev(section(version))).not.toContain('gazetta agents update')
  }, 120_000)
})
