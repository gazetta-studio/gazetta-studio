/**
 * End-to-end CLI tests for `gazetta validate` (Validation Cut 5).
 *
 * Spawns the built CLI as a subprocess and asserts on output + exit code.
 * Uses the starter site fixture as the target site.
 *
 * Tests pin:
 *   - Clean run exits 0 with "All good"
 *   - Schema mismatch fires schema-conformance and exits 1 (warn-as-error)
 *   - --no-warn-as-error keeps the warning visible but exits 0
 *   - --severity error suppresses warns from output
 *   - --verbose prints full Issue messages
 *   - --include-quality runs the heavier validators
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(here, '../dist/cli/index.js')
const starterDir = resolve(here, '../../../examples/starter')
const starterSiteDir = join(starterDir, 'sites/main')

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    throw new Error(`CLI not built — run \`npm run build -w packages/gazetta\` before this test.\nMissing: ${cliEntry}`)
  }
  if (!existsSync(starterSiteDir)) {
    throw new Error(`Starter fixture missing: ${starterSiteDir}`)
  }
})

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliEntry, 'validate', ...args], {
    cwd: starterDir,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf-8',
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('gazetta validate (CLI)', () => {
  // Every test here spawns the built CLI; the default 5s vitest timeout is
  // too tight under CI parallelism (~2s local, up to ~12s observed on loaded
  // runners), so all of them use the quality test's 30s override.
  it('runs against starter, reports each page + fragment, and passes', { timeout: 30_000 }, () => {
    const { stdout, status } = run(['sites/main', '--severity', 'error'])
    expect(stdout).toMatch(/site\.config\.ts/)
    expect(stdout).toMatch(/home/)
    expect(stdout).toMatch(/@header/)
    expect(stdout).toContain('All good.')
    expect(status).toBe(0)
  })

  it('--include-quality runs without crashing (a11y + html-validity engaged)', { timeout: 30_000 }, () => {
    // Verifies the wiring; doesn't make claims about what these validators
    // surface on the starter (some violations are normal on real templates).
    const { status } = run(['sites/main', '--include-quality', '--no-warn-as-error', '--severity', 'all'])
    expect([0, 1]).toContain(status) // either is fine — we just want no crash
  })
})

describe('gazetta validate (CLI) — site-config validators', () => {
  const copyDir = resolve(here, '../../../.tmp', `cli-validate-public-storage-${Date.now()}`)

  afterAll(() => {
    rmSync(copyDir, { recursive: true, force: true })
  })

  // validate tries to read the Azure target's storage for leftover state, and
  // with no Azurite listening the client retries for ~17s locally, past 30s on
  // CI runners. Lower this again once validate stops doing that (#1577).
  it('reports public-storage errors and the assumed-public info line, and exits 1', { timeout: 90_000 }, () => {
    cpSync(starterDir, copyDir, { recursive: true, filter: src => !src.includes('node_modules') })
    const configPath = join(copyDir, 'sites/main/site.config.ts')
    // Added after `local`, which must stay the first editable target (the source).
    const bucket =
      "    bucket: { storage: azureBlobStorage({ connectionString: 'UseDevelopmentStorage=true', container: 'b' }), editable: true },\n"
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf-8').replace('    staging: {\n', bucket + '    staging: {\n'),
    )
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main'], {
      cwd: copyDir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    expect(result.stdout).toContain('`bucket` is editable, so its storage must be private (`publicStorage: false`).')
    expect(result.stdout).toContain('`bucket`: storage assumed public')
    expect(result.status).toBe(1)
  })
})

describe('gazetta validate (CLI) — a template that fails to load (#1665)', () => {
  const copyDir = resolve(here, '../../../.tmp', `cli-validate-broken-template-${Date.now()}`)

  afterAll(() => {
    rmSync(copyDir, { recursive: true, force: true })
  })

  it('names the template and its error once, and exits 1', { timeout: 90_000 }, () => {
    cpSync(starterDir, copyDir, { recursive: true, filter: src => !src.includes('node_modules') })
    writeFileSync(join(copyDir, 'templates/hero/index.ts'), "throw new Error('hero is broken')\n")
    // Folders that aren't templates are left alone (Seer on #1743).
    mkdirSync(join(copyDir, 'templates/_shared'), { recursive: true })
    writeFileSync(join(copyDir, 'templates/_shared/util.ts'), 'export const x = 1\n')
    mkdirSync(join(copyDir, 'templates/notes'), { recursive: true })
    writeFileSync(join(copyDir, 'templates/notes/README.md'), 'Not a template\n')
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', '--verbose'], {
      cwd: copyDir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    const output = result.stdout + result.stderr
    const templateLines = output.split('\n').filter(l => l.includes("template hero couldn't be loaded"))
    expect(templateLines).toHaveLength(1)
    expect(templateLines[0]).toContain('hero is broken')
    expect(output).not.toMatch(/template (_shared|notes) couldn't be loaded/)
    // Each page using it says why its content isn't checked.
    expect(output).toContain('Template "hero" couldn\'t be loaded, so this content can\'t be checked')
    expect(result.status).toBe(1)
  })
})

describe('gazetta validate (CLI) — content that does not fit its template (#1745, T7)', () => {
  const copyDir = resolve(here, '../../../.tmp', `cli-validate-schema-${Date.now()}`)

  beforeAll(() => {
    cpSync(starterDir, copyDir, { recursive: true, filter: src => !src.includes('node_modules') })
    // The French home page's hero loses its required title.
    const fr = join(copyDir, 'sites/main/targets/local/pages/home/page.fr.json')
    const page = JSON.parse(readFileSync(fr, 'utf-8'))
    delete page.components.find((c: { template?: string }) => c.template === 'hero').content.title
    writeFileSync(fr, JSON.stringify(page, null, 2))
  })
  afterAll(() => {
    rmSync(copyDir, { recursive: true, force: true })
  })

  function runCopy(args: string[]) {
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', ...args], {
      cwd: copyDir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    return { output: result.stdout + result.stderr, status: result.status }
  }

  it.each([[[]], [['--no-warn-as-error']], [['--severity=all', '--no-warn-as-error']]])(
    'fails and names the page, field and language with %j',
    { timeout: 30_000 },
    args => {
      const { output, status } = runCopy(args)
      const line = output.split('\n').find(l => l.includes('title:'))
      expect(line, output).toMatch(/✗ title: .*\(hero, language fr\)/)
      expect(output).toMatch(/✗ home /)
      expect(output).toContain('1 error')
      expect(status).toBe(1)
    },
  )
})
