/**
 * The CLI's site and target prompts (cli.md "Auto-detection"): one choice
 * is used without asking, several prompt locally and fail in CI, and a
 * cancelled prompt exits cleanly. These are the only uses of
 * `@clack/prompts`, so this file is what notices when an upgrade changes it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './_helpers/temp.js'

const select = vi.hoisted(() => vi.fn())
vi.mock('@clack/prompts', () => ({ select }))

const { resolveSiteDir, resolveTarget } = await import('../src/cli/resolve-site-target.js')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`)
  }
}

let root: string
let exitSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
const savedCI = process.env.CI

function writeSite(dir: string, targets: string[]): void {
  mkdirSync(dir, { recursive: true })
  const entries = targets.map(t => `${JSON.stringify(t)}: {}`).join(', ')
  writeFileSync(join(dir, 'site.config.mjs'), `export default { name: 'x', targets: { ${entries} } }\n`)
}

function errorOutput(): string {
  return errorSpy.mock.calls.map(call => call.join(' ')).join('\n')
}

beforeEach(({ task }) => {
  root = tempDir(`cli-resolve-site-target-${task.id}-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code)
  }) as never)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  select.mockReset()
  delete process.env.CI
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedCI === undefined) delete process.env.CI
  else process.env.CI = savedCI
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSiteDir', () => {
  it('uses the only site without prompting', async () => {
    writeSite(join(root, 'sites/main'), ['local'])
    expect(await resolveSiteDir(undefined, 'dev')).toBe(join(root, 'sites/main'))
    expect(select).not.toHaveBeenCalled()
  })

  it('prompts with every site when there are several, and uses the choice', async () => {
    writeSite(join(root, 'sites/alpha'), ['local'])
    writeSite(join(root, 'sites/beta'), ['local'])
    select.mockResolvedValue('beta')
    expect(await resolveSiteDir(undefined, 'dev')).toBe(join(root, 'sites/beta'))
    expect(select).toHaveBeenCalledTimes(1)
    const opts = select.mock.calls[0][0]
    expect(opts.message).toBe('Select site:')
    expect(opts.options.map((o: { value: string }) => o.value).sort()).toEqual(['alpha', 'beta'])
  })

  it('fails in CI with the available sites instead of prompting', async () => {
    writeSite(join(root, 'sites/alpha'), ['local'])
    writeSite(join(root, 'sites/beta'), ['local'])
    process.env.CI = 'true'
    await expect(resolveSiteDir(undefined, 'publish')).rejects.toEqual(new ExitError(1))
    expect(select).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('multiple sites found')
    expect(errorOutput()).toContain('alpha, beta')
  })

  it('exits 0 when the prompt is cancelled', async () => {
    writeSite(join(root, 'sites/alpha'), ['local'])
    writeSite(join(root, 'sites/beta'), ['local'])
    select.mockResolvedValue(Symbol('clack:cancel'))
    await expect(resolveSiteDir(undefined, 'dev')).rejects.toEqual(new ExitError(0))
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('skips the prompt when a site is named', async () => {
    writeSite(join(root, 'sites/alpha'), ['local'])
    writeSite(join(root, 'sites/beta'), ['local'])
    expect(await resolveSiteDir('beta', 'dev')).toBe(join(root, 'sites/beta'))
    expect(select).not.toHaveBeenCalled()
  })
})

describe('resolveTarget', () => {
  it('uses the only target without prompting', async () => {
    const site = join(root, 'sites/main')
    writeSite(site, ['local'])
    expect(await resolveTarget(undefined, site, 'publish')).toBe('local')
    expect(select).not.toHaveBeenCalled()
  })

  it('prompts with every target when there are several, and uses the choice', async () => {
    const site = join(root, 'sites/main')
    writeSite(site, ['staging', 'production'])
    select.mockResolvedValue('production')
    expect(await resolveTarget(undefined, site, 'publish')).toBe('production')
    expect(select).toHaveBeenCalledTimes(1)
    const opts = select.mock.calls[0][0]
    expect(opts.message).toBe('Select target:')
    expect(opts.options.map((o: { value: string }) => o.value)).toEqual(['staging', 'production'])
  })

  it('fails in CI with the available targets instead of prompting', async () => {
    const site = join(root, 'sites/main')
    writeSite(site, ['staging', 'production'])
    process.env.CI = 'true'
    await expect(resolveTarget(undefined, site, 'publish')).rejects.toEqual(new ExitError(1))
    expect(select).not.toHaveBeenCalled()
    expect(errorOutput()).toContain('multiple targets found')
    expect(errorOutput()).toContain('staging, production')
  })

  it('exits 0 when the prompt is cancelled', async () => {
    const site = join(root, 'sites/main')
    writeSite(site, ['staging', 'production'])
    select.mockResolvedValue(Symbol('clack:cancel'))
    await expect(resolveTarget(undefined, site, 'publish')).rejects.toEqual(new ExitError(0))
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('skips the prompt when a target is named', async () => {
    const site = join(root, 'sites/main')
    writeSite(site, ['staging', 'production'])
    expect(await resolveTarget('staging', site, 'publish')).toBe('staging')
    expect(select).not.toHaveBeenCalled()
  })
})
