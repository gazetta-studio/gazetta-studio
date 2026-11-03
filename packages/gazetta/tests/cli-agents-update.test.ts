/**
 * `gazetta agents update` and the `gazetta dev` hint, run as the CLI
 * (design-agent-access.md Q33, #1735).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
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
/** Children with a promise that settles once their stdio is closed. */
const children: { child: ChildProcess; closed: Promise<void> }[] = []

function track(child: ChildProcess): { child: ChildProcess; closed: Promise<void> } {
  const tracked = { child, closed: new Promise<void>(done => child.once('close', () => done())) }
  children.push(tracked)
  return tracked
}

/**
 * Stop a child and wait for `close`, not `exit`: `close` waits for every
 * process holding its stdio, so the dev server tsx started has exited too
 * and nothing writes into its folder afterwards.
 */
async function stop({ child, closed }: { child: ChildProcess; closed: Promise<void> }): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await closed
}

/** A port nothing is listening on, from the OS. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise<void>(done => server.close(() => done()))
  return port
}

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child)
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
    const port = String(await freePort())
    const dev = spawn(tsxBin, [cliPath, 'dev', '--host', '127.0.0.1', '-p', port], {
      cwd: project,
      env: { ...process.env, CI: 'true' },
    })
    const tracked = track(dev)
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
    // One dev server at a time: the next start must not find this one
    // still holding a port or writing Vite's cache into its folder.
    await stop(tracked)
    return out
  }

  it('prints the hint for an older section, and nothing for a current one', async () => {
    expect(await startDev(section('0.0.1'))).toContain(
      "AGENTS.md has Gazetta's agent section from 0.0.1; run `gazetta agents update`.",
    )
    expect(await startDev(section(version))).not.toContain('gazetta agents update')
  }, 120_000)
})
