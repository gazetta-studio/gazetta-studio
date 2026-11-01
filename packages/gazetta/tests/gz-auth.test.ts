/**
 * gz signs in to a real `gazetta dev` (design-agent-access.md Q12, Q16,
 * Q21; cut 12): builds the gz binary, runs `gz auth login` with the approve
 * step done over HTTP as the browser would, then `gz auth status` and
 * `gz auth logout`, and checks the grant no longer renews.
 *
 * Needs Go (preinstalled on GitHub's Ubuntu runners). Skipped locally when
 * `go` isn't on PATH; in CI a missing Go fails it.
 *
 * Slow: one Go build and one long-lived dev server.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cp, readFile, rm } from 'node:fs/promises'
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

  function gzRun(...args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(gz, args, { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { code: e.status, stdout: e.stdout, stderr: e.stderr }
    }
  }

  it('logs in, shows the login renewing, and logs out so it no longer renews', async () => {
    // Login: approve the code as soon as gz prints it.
    const login = spawn(gz, ['auth', 'login', admin, '--name', 'dev', '--json'], { env: env() })
    let stdout = ''
    let stderr = ''
    login.stdout.on('data', d => (stdout += d))
    const code = await new Promise<string>((resolveCode, reject) => {
      login.stderr.on('data', d => {
        stderr += d
        const m = /Your code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(stderr)
        if (m) resolveCode(m[1])
      })
      login.once('close', () => reject(new Error(`gz exited before showing a code: ${stderr}${devTail()}`)))
    })
    const approve = await fetch(`${admin}/admin/api/v1/auth/logins/${code}/approve`, { method: 'POST' })
    expect(approve.status, devTail()).toBe(200)
    const exit = await new Promise<number | null>(r => login.once('close', r))
    expect(exit, stderr + devTail()).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ name: 'dev', url: admin, default: true })

    const status = gzRun('auth', 'status', '--json')
    expect(status.code, status.stderr + devTail()).toBe(0)
    expect(JSON.parse(status.stdout).profiles).toEqual([{ name: 'dev', url: admin, default: true, login: 'renews' }])

    const grantSecret = await readFile(join(config, 'grants', 'dev.grant'), 'utf8')
    const logout = gzRun('auth', 'logout', '--json')
    expect(logout.code, logout.stderr + devTail()).toBe(0)
    expect(JSON.parse(logout.stdout)).toMatchObject({ removed: 'dev', revoked: true })

    const renew = await fetch(`${admin}/admin/api/v1/auth/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantSecret }),
    })
    expect(renew.status).toBe(401)
  }, 120_000)
})
