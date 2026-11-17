/**
 * A site whose production target needs keys the person running the CLI
 * doesn't have still loads: commands that don't use that target work, and
 * the ones that do stop with the missing-key message (#1185).
 *
 * Spawns the CLI against a temp copy of the starter whose site.config.ts
 * adds an R2 production target deployed by `cloudflareWorkersDeploy`, with
 * every R2 and Cloudflare variable removed from the environment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, rm, writeFile, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

const CONFIG = `import { cloudflareWorkersDeploy, defineSite, filesystemStorage, r2Storage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Starter',
  version: '1.0.0',
  systemPages: ['404'],
  targets: {
    local: {
      storage: filesystemStorage({ path: './targets/local' }),
      publicStorage: false,
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      publicStorage: false,
      environment: 'staging',
    },
    production: {
      type: 'dynamic',
      environment: 'production',
      storage: r2Storage({
        accountId: 'acc',
        bucket: 'my-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: 'acc',
        name: 'my-site',
        bucket: 'my-site',
      }),
    },
  },
})
`

function runCli(cwd: string, args: string[]): Promise<{ output: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' }
  for (const key of Object.keys(env)) if (/^(R2_|CLOUDFLARE_)/.test(key)) delete env[key]
  return new Promise(done => {
    const child = spawn(tsxBin, [cliPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))
    child.on('close', code => done({ output, code: code ?? 0 }))
  })
}

describe('a target without its keys', { timeout: 180000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-missing-credentials-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
    await writeFile(resolve(projectDir, 'sites/main/site.config.ts'), CONFIG)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('leaves publishing to another target working', async () => {
    const res = await runCli(projectDir, ['publish', 'staging'])
    expect(res.output).not.toContain('Failed to evaluate config')
    expect(res.code).toBe(0)
    expect((await stat(join(projectDir, 'sites/main/dist/staging/pages'))).isDirectory()).toBe(true)
  })

  it('stops publishing to that target with the missing-key message', async () => {
    const res = await runCli(projectDir, ['publish', 'production'])
    expect(res.output).not.toContain('Failed to evaluate config')
    expect(res.code).not.toBe(0)
    expect(res.output).toContain('r2Storage: "accessKeyId" is required. Set R2_ACCESS_KEY_ID')
  })

  it('stops deploying that target with the missing-token message', async () => {
    const res = await runCli(projectDir, ['deploy', 'production'])
    expect(res.output).not.toContain('Failed to evaluate config')
    expect(res.code).toBe(1)
    expect(res.output).toContain('cloudflareWorkersDeploy requires `apiToken` (e.g., process.env.CLOUDFLARE_API_TOKEN)')
  })

  it('has gazetta validate list the target and each missing option', async () => {
    const res = await runCli(projectDir, ['validate', '--severity', 'warn'])
    expect(res.output).not.toContain('Failed to evaluate config')
    expect(res.output).toContain('`production`: r2Storage: "accessKeyId" is required. Set R2_ACCESS_KEY_ID')
    expect(res.output).toContain('`production`: r2Storage: "secretAccessKey" is required. Set R2_SECRET_ACCESS_KEY')
    expect(res.output).toContain('`production`: cloudflareWorkersDeploy requires `apiToken`')
    expect(res.output).not.toContain("Couldn't check `production`'s storage")
  })
})
