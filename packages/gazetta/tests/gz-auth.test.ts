/**
 * gz signs in to a real `gazetta dev` (design-agent-access.md Q12, Q16,
 * Q21; cut 12): builds the gz binary, runs `gz auth login` with the approve
 * step done over HTTP as the browser would, then `gz auth status` and
 * `gz auth logout`, and checks the grant no longer renews.
 *
 * Needs Go (preinstalled on GitHub's Ubuntu runners). Skipped locally when
 * `go` isn't on PATH; in CI a missing Go fails it.
 *
 * A second test runs the content commands (cut 13): set, get, edit,
 * create, preview, status, templates schema and validate, with the run id.
 *
 * Slow: one Go build and one long-lived dev server.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './_helpers/temp.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

function hasGo(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const runIt = hasGo() || process.env.CI === 'true'

describe.runIf(runIt)('gz auth against gazetta dev', () => {
  const work = tempDir(`gz-auth-${Date.now()}`)
  const project = join(work, 'project')
  const config = join(work, 'gz-config')
  const gz = join(work, process.platform === 'win32' ? 'gz.exe' : 'gz')
  const port = 5000 + Math.floor(Math.random() * 100)
  const admin = `http://127.0.0.1:${port}`
  let dev: ChildProcess | undefined
  // The dev server's output, attached to failures so a slow or failed start shows why.
  let devLog = ''
  const devTail = () => `\n--- gazetta dev output ---\n${devLog.slice(-8000)}`

  beforeAll(async () => {
    execFileSync('go', ['build', '-o', gz, './cmd/gz'], {
      cwd: resolve(repoRoot, 'gz'),
      env: { ...process.env, CGO_ENABLED: '0' },
      stdio: 'inherit',
    })
    await cp(resolve(repoRoot, 'examples/starter'), project, { recursive: true })
    // Production on a folder instead of the Azurite emulator, so the test can publish there.
    const configPath = join(project, 'sites/main/site.config.ts')
    const config = await readFile(configPath, 'utf8')
    const azure = /storage: azureBlobStorage\(\{[^}]*\}\)/
    if (!azure.test(config)) throw new Error("the starter's production target changed; update this test")
    await writeFile(configPath, config.replace(azure, "storage: filesystemStorage({ path: './dist/production' })"))
    dev = spawn(tsxBin, [cliPath, 'dev', '--host', '127.0.0.1', '-p', String(port)], {
      cwd: project,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    dev.stdout?.on('data', d => (devLog += d))
    dev.stderr?.on('data', d => (devLog += d))
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        if ((await fetch(`${admin}/admin/api/health`)).ok) break
      } catch {}
      if (Date.now() > deadline) throw new Error(`gazetta dev did not start${devTail()}`)
      await new Promise(r => setTimeout(r, 400))
    }
  }, 180_000)

  afterAll(async () => {
    if (dev) {
      dev.kill('SIGTERM')
      await new Promise(r => dev!.once('close', r))
    }
    await rm(work, { recursive: true, force: true })
  })

  const env = () => ({ ...process.env, GZ_CONFIG_DIR: config, GZ_GRANT_STORE: 'file' })

  function gzRun(
    args: string[],
    opts: { vars?: Record<string, string>; input?: string } = {},
  ): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(gz, args, {
        env: { ...env(), ...opts.vars },
        encoding: 'utf8',
        input: opts.input ?? '',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { code: e.status, stdout: e.stdout, stderr: e.stderr }
    }
  }

  /** Runs gz until it shows a code, approves the code over HTTP as the browser would, and waits for gz. */
  async function approved(args: string[]): Promise<{ stdout: string; stderr: string }> {
    // CI=true would make gz print the code and exit instead of waiting (Q29).
    const run = spawn(gz, args, { env: { ...env(), CI: '' } })
    let stdout = ''
    let stderr = ''
    run.stdout.on('data', d => (stdout += d))
    // Listen for the exit now: gz may exit before the code is approved.
    const exited = new Promise<number | null>(r => run.once('close', r))
    const code = await new Promise<string>((resolveCode, reject) => {
      run.stderr.on('data', d => {
        stderr += d
        const m = /Your code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(stderr)
        if (m) resolveCode(m[1])
      })
      run.once('close', () => reject(new Error(`gz exited before showing a code: ${stderr}${devTail()}`)))
    })
    const approve = await fetch(`${admin}/admin/api/v1/auth/logins/${code}/approve`, { method: 'POST' })
    expect(approve.status, devTail()).toBe(200)
    expect(await exited, stderr + devTail()).toBe(0)
    return { stdout, stderr }
  }

  /** `gz auth login`, approved over HTTP. */
  const login = () => approved(['auth', 'login', admin, '--name', 'dev', '--json'])

  it('logs in, shows the login renewing, and logs out so it no longer renews', async () => {
    const { stdout } = await login()
    expect(JSON.parse(stdout)).toMatchObject({ name: 'dev', url: admin, default: true })

    const status = gzRun(['auth', 'status', '--json'])
    expect(status.code, status.stderr + devTail()).toBe(0)
    expect(JSON.parse(status.stdout).profiles).toEqual([{ name: 'dev', url: admin, default: true, login: 'renews' }])

    const grantSecret = await readFile(join(config, 'grants', 'dev.grant'), 'utf8')
    const logout = gzRun(['auth', 'logout', '--json'])
    expect(logout.code, logout.stderr + devTail()).toBe(0)
    expect(JSON.parse(logout.stdout)).toMatchObject({ removed: 'dev', revoked: true })

    const renew = await fetch(`${admin}/admin/api/v1/auth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantSecret }),
    })
    expect(renew.status).toBe(401)
  }, 120_000)

  // Cut 13 (#1721): the content commands against the starter site.
  it('edits, checks and creates content, with saves in the run', async () => {
    await login()
    const t1 = { vars: { GZ_RUN: 't1' } }
    const ok = (r: { code: number; stdout: string; stderr: string }, what: string) =>
      expect(r.code, `${what}: ${r.stdout}${r.stderr}${devTail()}`).toBe(0)

    ok(gzRun(['pages', 'set', 'home', 'components.hero.content.title=From gz'], t1), 'set')
    const got = gzRun(['pages', 'get', 'home', '--json'])
    ok(got, 'get')
    const home = JSON.parse(got.stdout) as {
      etag: string
      manifest: { components: Array<{ name?: string; content?: { title?: string } }> }
    }
    expect(home.manifest.components.find(c => c.name === 'hero')?.content?.title).toBe('From gz')

    // Two items go through the bulk save; a failing one writes neither.
    ok(
      gzRun(
        [
          'pages',
          'set',
          'home',
          'components.hero.content.subtitle=Both',
          'about',
          'components.about-text.content.heading=Both',
        ],
        t1,
      ),
      'set two',
    )
    const refused = gzRun([
      'pages',
      'set',
      'home',
      'components.hero.content.title=Neither',
      'about',
      'components.about-text.content.heading:=null',
    ])
    expect(refused.code, refused.stderr).toBe(1)
    expect(refused.stderr).toContain('heading')
    const after = JSON.parse(gzRun(['pages', 'get', 'home', '--json']).stdout) as typeof home
    expect(after.manifest.components.find(c => c.name === 'hero')?.content?.title).toBe('From gz')

    expect(gzRun(['pages', 'set', 'nope', 'content.x=1']).code).toBe(5)
    const invalid = gzRun(['pages', 'set', 'home', 'components.hero.content.title:=null'])
    expect(invalid.code, invalid.stderr).toBe(1)
    expect(invalid.stderr).toContain('at hero: title')

    // Both GZ_RUN=t1 commands' saves are in run t1.
    const runRevisions = await readdir(join(project, 'sites/main/targets/local/.gazetta/history/runs/t1/revisions'))
    expect(runRevisions).toHaveLength(2)

    const edited = { ...after.manifest, metadata: { title: 'Edited from stdin' } }
    ok(gzRun(['pages', 'edit', 'home'], { input: JSON.stringify(edited) }), 'edit')
    ok(gzRun(['pages', 'create', 'contact', '--template', 'page-default']), 'create')
    expect(JSON.parse(gzRun(['pages', 'list', '--json']).stdout).pages.map((p: { name: string }) => p.name)).toContain(
      'contact',
    )

    const preview = gzRun(['preview', 'home', '--html'])
    ok(preview, 'preview')
    expect(preview.stdout).toContain('From gz')

    const status = gzRun(['status', '--json'])
    ok(status, 'status')
    expect(JSON.parse(status.stdout).modified.length + JSON.parse(status.stdout).added.length).toBeGreaterThan(0)

    const schema = gzRun(['templates', 'schema', 'hero', '--json'])
    ok(schema, 'schema')
    expect(JSON.parse(schema.stdout).properties).toHaveProperty('title')
    expect([0, 1]).toContain(gzRun(['validate', '--json']).code)

    // Undo run t1 (#1730): home changed since (the edit above), about didn't.
    const shown = gzRun(['runs', 'show', 't1', '--json'])
    ok(shown, 'runs show')
    const items = JSON.parse(shown.stdout).items as Array<{ item: string; changed: boolean }>
    expect(items.find(i => i.item === 'pages.home')?.changed).toBe(true)
    expect(items.find(i => i.item === 'pages.about')?.changed).toBe(false)
    const reverted = gzRun(['runs', 'revert', 't1', '--json'])
    // Exit 4: an item was skipped because someone edited it since (Q38).
    expect(reverted.code, reverted.stderr + devTail()).toBe(4)
    const outcome = JSON.parse(reverted.stdout) as { items: Array<{ item: string; status: string }> }
    expect(outcome.items.find(i => i.item === 'pages.home')?.status).toBe('skipped-changed')
    expect(outcome.items.find(i => i.item === 'pages.about')?.status).toBe('reverted')
    const about = JSON.parse(gzRun(['pages', 'get', 'about', '--json']).stdout) as typeof home
    expect(JSON.stringify(about.manifest)).not.toContain('Both')
  }, 120_000)

  it('publishes after an elevation, and uploads an asset', async () => {
    await login()
    const ok = (r: ReturnType<typeof gzRun>, what: string) => expect(r.code, `${what}: ${r.stderr}${devTail()}`).toBe(0)

    // The token can't publish until the person approves an elevation (Q12, Q29).
    const first = await approved(['publish', 'home', '--to', 'staging'])
    expect(first.stderr).toContain('non-production elevation')
    expect(first.stdout).toContain('Published 1 items to staging')
    // Within the elevation's 15 minutes, no new code (Q17).
    const second = gzRun(['publish', 'about', '--to', 'staging'])
    ok(second, 'second publish')
    expect(second.stderr).not.toContain('Your code')
    ok(gzRun(['elevate', '--end']), 'elevate --end')

    // One code for production: its elevation covers the non-production check too (#1729).
    const production = await approved(['publish', 'home', '--to', 'production'])
    expect(production.stdout).toContain('Published 1 items to production')
    expect(production.stderr.match(/Your code:/g)).toHaveLength(1)
    expect(production.stderr).toContain('production elevation')
    ok(gzRun(['elevate', '--end']), 'elevate --end after production')
    const after = gzRun(['publish', 'about', '--to', 'staging', '--no-wait'])
    expect(after.code, after.stderr).toBe(3)

    const png = join(work, 'dot.png')
    await writeFile(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    ok(gzRun(['assets', 'upload', png, '--name', 'gz-dot', '--alt', 'A dot']), 'upload')
    ok(gzRun(['assets', 'alt', 'gz-dot', 'A single dot']), 'alt')
    const list = gzRun(['assets', 'list', '--json'])
    ok(list, 'list')
    const dot = (JSON.parse(list.stdout).assets as { name: string; alt: string | null }[]).find(
      a => a.name === 'gz-dot',
    )
    expect(dot?.alt).toBe('A single dot')
  }, 120_000)
})
