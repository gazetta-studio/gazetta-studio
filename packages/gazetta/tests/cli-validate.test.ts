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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

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

describe('gazetta validate (CLI) — --json and --format github (#1748)', () => {
  const brokenDir = resolve(here, '../../../.tmp', `cli-validate-report-${Date.now()}`)
  const cleanDir = resolve(here, '../../../.tmp', `cli-validate-report-clean-${Date.now()}`)
  const pages = (dir: string) => join(dir, 'sites/main/targets/local/pages')

  beforeAll(() => {
    for (const dir of [brokenDir, cleanDir])
      cpSync(starterDir, dir, { recursive: true, filter: src => !src.includes('node_modules') })
    const edit = (path: string, change: (json: any) => void) => {
      const json = JSON.parse(readFileSync(path, 'utf-8'))
      change(json)
      writeFileSync(path, JSON.stringify(json, null, 2))
    }
    const noTitle = { name: 'hero', template: 'hero', content: { subtitle: 'x' } }
    // Two pages (one in French) and one fragment break hero; about also names a missing fragment.
    edit(join(pages(brokenDir), 'home/page.fr.json'), p => {
      p.components.find((c: { template?: string }) => c.template === 'hero').content = { subtitle: 'x' }
    })
    edit(join(pages(brokenDir), 'about/page.json'), p => p.components.push(noTitle, '@missing'))
    const promo = join(brokenDir, 'sites/main/targets/local/fragments/promo')
    mkdirSync(promo, { recursive: true })
    writeFileSync(join(promo, 'fragment.json'), JSON.stringify({ template: 'hero', content: {} }))
    // A broken language file makes the site load with a warning.
    writeFileSync(join(pages(brokenDir), 'about/page.de.json'), '{ not json')
  })
  afterAll(() => {
    rmSync(brokenDir, { recursive: true, force: true })
    rmSync(cleanDir, { recursive: true, force: true })
  })

  function runIn(dir: string, args: string[], env: Record<string, string> = {}) {
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', GITHUB_STEP_SUMMARY: '', ...env },
      encoding: 'utf-8',
    })
    return { stdout: result.stdout, stderr: result.stderr, status: result.status }
  }

  it('--json prints one document that groups the hero problems and lists the missing fragment', {
    timeout: 30_000,
  }, async () => {
    const { ValidateReportSchema } = await import('../src/cli/validate-report.js')
    const { stdout, status } = runIn(brokenDir, ['--json'])
    const report = ValidateReportSchema.parse(JSON.parse(stdout))
    expect(report.ok).toBe(false)
    const hero = report.templates.find(t => t.template === 'hero')!
    expect(hero.file).toBe('templates/hero/index.ts')
    expect(hero.items.map(i => [i.kind, i.name, i.locale])).toEqual([
      ['page', 'about', null],
      ['page', 'home', 'fr'],
      ['fragment', 'promo', null],
    ])
    expect(hero.items[0].issues[0]).toMatchObject({ component: 'hero', contentPath: 'title' })
    expect(report.other).toContainEqual(expect.objectContaining({ kind: 'page', name: 'about' }))
    expect(status).toBe(1)
  })

  it('--format github writes a summary per template and one annotation on hero', { timeout: 30_000 }, () => {
    const summaryFile = join(brokenDir, 'summary.md')
    const { stdout, status } = runIn(brokenDir, ['--format', 'github'], { GITHUB_STEP_SUMMARY: summaryFile })
    const summary = readFileSync(summaryFile, 'utf-8')
    expect(summary).toContain('### `hero` (`templates/hero/index.ts`)')
    expect(summary).toContain('| pages/home | fr | hero › title |')
    expect(summary).toContain('### Other problems')
    const annotations = stdout.split('\n').filter(l => l.startsWith('::'))
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatch(/^::error file=templates\/hero\/index\.ts,title=hero doesn't fit 3 items::/)
    expect(status).toBe(1)
  })

  it('--format github on a clean site is one line and no annotation', { timeout: 30_000 }, () => {
    const { stdout, status } = runIn(cleanDir, ['--format=github'])
    expect(stdout).toBe('**Template check passed.**\n')
    expect(status).toBe(0)
  })
})

describe('gazetta validate (CLI) — a large --json report through a pipe (Seer on #1749)', () => {
  const dir = resolve(here, '../../../.tmp', `cli-validate-large-${Date.now()}`)

  beforeAll(() => {
    cpSync(starterDir, dir, { recursive: true, filter: src => !src.includes('node_modules') })
    // 300 pages whose hero lacks its title: a report well over a 64 KB pipe buffer.
    for (let i = 0; i < 300; i++) {
      const page = join(dir, 'sites/main/targets/local/pages', `broken-${i}`)
      mkdirSync(page, { recursive: true })
      writeFileSync(
        join(page, 'page.json'),
        JSON.stringify({
          template: 'page-default',
          route: `/broken-${i}`,
          components: [{ name: 'hero', template: 'hero', content: {} }],
        }),
      )
    }
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints the whole document before exiting 1', { timeout: 60_000 }, () => {
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', '--json'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
    expect(result.stdout.length).toBeGreaterThan(64 * 1024)
    const report = JSON.parse(result.stdout)
    expect(report.templates.find((t: { template: string }) => t.template === 'hero').items).toHaveLength(300)
    expect(result.status).toBe(1)
  })
})

describe('gazetta validate (CLI) — --base (#1750)', () => {
  const made: string[] = []
  const pagesOf = (dir: string) => join(dir, 'sites/main/targets/local/pages')
  const git = (dir: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    })
  const heroPage = (dir: string, name: string) => {
    mkdirSync(join(pagesOf(dir), name), { recursive: true })
    writeFileSync(
      join(pagesOf(dir), name, 'page.json'),
      JSON.stringify({
        template: 'page-default',
        route: `/${name}`,
        components: [{ name: 'hero', template: 'hero', content: {} }],
      }),
    )
  }
  const addRef = (dir: string, page: string, ref: string) => {
    const path = join(pagesOf(dir), page, 'page.json')
    const json = JSON.parse(readFileSync(path, 'utf-8'))
    json.components.push(ref)
    writeFileSync(path, JSON.stringify(json))
  }

  /** A starter copy in its own git repository; `base` changes what the base commit has. */
  function repo(base: (dir: string) => void = () => {}): string {
    const dir = resolve(here, '../../../.tmp', `cli-validate-base-${Date.now()}-${made.length}`)
    made.push(dir)
    cpSync(starterDir, dir, { recursive: true, filter: src => !src.includes('node_modules') && !src.includes('/dist') })
    base(dir)
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    return dir
  }
  function validate(dir: string, args: string[]) {
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', '--json', ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    return { report: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr, status: result.status }
  }
  const names = (templates: { template: string; items: { name: string; locale: string | null }[] }[]) =>
    templates.flatMap(t => t.items.map(i => `${t.template}:${i.name}${i.locale ? `:${i.locale}` : ''}`))
  const leftovers = (dir: string) => {
    const tmp = join(dir, '.gazetta/tmp')
    return existsSync(tmp) ? readdirSync(tmp) : []
  }

  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  it('fails on two newly broken pages and lists the one main already had, even with the message reworded', {
    timeout: 60_000,
  }, () => {
    const dir = repo(d => heroPage(d, 'old'))
    heroPage(dir, 'new-a')
    heroPage(dir, 'new-b')
    // A schema change that only rewords the message for the field `old` already broke.
    const hero = join(dir, 'templates/hero/index.ts')
    writeFileSync(
      hero,
      readFileSync(hero, 'utf-8').replace('title: z.string()', "title: z.string({ error: 'A title is required' })"),
    )
    const { report, status } = validate(dir, ['--base', 'HEAD'])
    expect(names(report.templates).sort()).toEqual(['hero:new-a', 'hero:new-b'])
    expect(names(report.alreadyBroken.templates)).toEqual(['hero:old'])
    expect(report.alreadyBroken.templates[0].items[0].issues[0].message).toContain('A title is required')
    expect(report.counts.error).toBe(2)
    expect(status).toBe(1)
    expect(leftovers(dir)).toEqual([])
  })

  it('passes when nothing changed, listing what main already had', { timeout: 60_000 }, () => {
    const dir = repo(d => heroPage(d, 'old'))
    const { report, status } = validate(dir, ['--base', 'HEAD'])
    expect(report.ok).toBe(true)
    expect(report.templates).toEqual([])
    expect(names(report.alreadyBroken.templates)).toEqual(['hero:old'])
    expect(status).toBe(0)
  })

  it('fails on a new missing fragment, and passes when it only keeps an old one', { timeout: 60_000 }, () => {
    const kept = repo(d => addRef(d, 'about', '@gone'))
    expect(validate(kept, ['--base', 'HEAD']).status).toBe(0)
    const added = repo()
    addRef(added, 'about', '@gone')
    const { report, status } = validate(added, ['--base', 'HEAD'])
    expect(report.other).toContainEqual(expect.objectContaining({ kind: 'page', name: 'about' }))
    expect(status).toBe(1)
  })

  it("exits 2 for a ref git can't find, and leaves nothing behind", { timeout: 60_000 }, () => {
    const dir = repo()
    const { stderr, status } = validate(dir, ['--base', 'nope'])
    expect(stderr).toContain("--base nope: git can't find that commit")
    expect(status).toBe(2)
    expect(leftovers(dir)).toEqual([])
  })
})

describe('gazetta validate (CLI) — --targets (#1754)', () => {
  const made: string[] = []
  const deny = "async () => { throw new Error('access denied') }"
  const extraTargets =
    "    pub: { storage: filesystemStorage({ path: './dist/pub' }) },\n" +
    `    denied: { storage: { readFile: ${deny}, writeFile: ${deny}, readDir: ${deny}, exists: ${deny}, mkdir: ${deny}, rm: ${deny} }, publicStorage: false },\n`
  const git = (dir: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    })

  /** A starter copy whose staging target holds a page `promo` with a hero lacking its title. */
  function project(): string {
    const dir = resolve(here, '../../../.tmp', `cli-validate-targets-${Date.now()}-${made.length}`)
    made.push(dir)
    cpSync(starterDir, dir, { recursive: true, filter: src => !src.includes('node_modules') && !src.includes('/dist') })
    const config = join(dir, 'sites/main/site.config.ts')
    writeFileSync(config, readFileSync(config, 'utf-8').replace('    staging: {\n', `${extraTargets}    staging: {\n`))
    const promo = join(dir, 'sites/main/dist/staging/pages/promo')
    mkdirSync(promo, { recursive: true })
    writeFileSync(
      join(promo, 'page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/promo',
        components: [{ name: 'hero', template: 'hero', content: {} }],
      }),
    )
    return dir
  }
  function validate(dir: string, args: string[]) {
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', '--json', ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    return { report: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr, status: result.status }
  }

  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  it('fails on a target page that breaks hero, naming the target and the fix', { timeout: 60_000 }, () => {
    const { report, status } = validate(project(), ['--targets', 'staging'])
    const hero = report.templates.find((t: { template: string }) => t.template === 'hero')
    expect(hero.items).toEqual([
      expect.objectContaining({
        kind: 'page',
        name: 'promo',
        locale: null,
        target: 'staging',
        fix: "pages/promo on staging doesn't fit the new `hero`: publish staging → local, fix it here.",
        issues: [expect.objectContaining({ component: 'hero', contentPath: 'title' })],
      }),
    ])
    expect(status).toBe(1)
  })

  it('lists a target page already broken under the base templates, and passes', { timeout: 60_000 }, () => {
    const dir = project()
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    const { report, status } = validate(dir, ['--targets', 'staging', '--base', 'HEAD'])
    expect(report.templates).toEqual([])
    expect(report.alreadyBroken.templates[0].items).toEqual([
      expect.objectContaining({ name: 'promo', target: 'staging', fix: null }),
    ])
    expect(status).toBe(0)
  })

  it('passes on a freshly published static target, whose fragments are baked into its pages', {
    timeout: 120_000,
  }, () => {
    const dir = project()
    rmSync(join(dir, 'sites/main/dist/staging'), { recursive: true, force: true })
    const published = spawnSync('node', [cliEntry, 'publish', 'staging', 'sites/main', '--force'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', CI: 'true' },
      encoding: 'utf-8',
    })
    expect(published.status, published.stdout + published.stderr).toBe(0)
    expect(existsSync(join(dir, 'sites/main/dist/staging/fragments'))).toBe(false)
    const { report, status } = validate(dir, ['--targets', 'staging'])
    expect(report.templates).toEqual([])
    expect(report.other.filter((o: { target?: string | null }) => o.target === 'staging')).toEqual([])
    expect(status).toBe(0)
  })

  it.each([
    ['nope', 'No target named `nope`. Targets: local, pub, denied, staging, esi-test, production.'],
    ['pub', '`pub` is public storage, which holds no manifests. Remove it from `--targets`.'],
    ['denied', "Couldn't read target `denied`: access denied"],
  ])('refuses --targets %s with exit 2', { timeout: 60_000 }, (name, message) => {
    const { stderr, status } = validate(project(), ['--targets', name])
    expect(stderr).toContain(message)
    expect(status).toBe(2)
  })
})

describe('gazetta validate (CLI) — --render (#1755)', () => {
  const made: string[] = []
  const git = (dir: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    })
  /** Make `templates/<name>` throw `message` on every render. */
  const throwing = (dir: string, name: string, message: string) => {
    const path = join(dir, 'templates', name, 'index.ts')
    const source = readFileSync(path, 'utf-8').replace(
      /^export default template$/m,
      `const checked: TemplateFunction = params => {\n  throw new Error(${JSON.stringify(message)})\n  return template(params)\n}\nexport default checked`,
    )
    writeFileSync(path, source)
  }
  /** Make `templates/<name>` record each render in `<dir>/renders.log`. */
  const recording = (dir: string, name: string) => {
    const path = join(dir, 'templates', name, 'index.ts')
    const log = JSON.stringify(join(dir, 'renders.log'))
    const source = `import { appendFileSync } from 'node:fs'\n${readFileSync(path, 'utf-8')}`.replace(
      /^export default template$/m,
      `const recorded: TemplateFunction = params => {\n  appendFileSync(${log}, ${JSON.stringify(`${name}\n`)})\n  return template(params)\n}\nexport default recorded`,
    )
    writeFileSync(path, source)
  }
  /** A starter copy in its own git repository; `base` changes what the base commit has. */
  function repo(base: (dir: string) => void = () => {}): string {
    const dir = resolve(here, '../../../.tmp', `cli-validate-render-${Date.now()}-${made.length}`)
    made.push(dir)
    cpSync(starterDir, dir, { recursive: true, filter: src => !src.includes('node_modules') && !src.includes('/dist') })
    base(dir)
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    return dir
  }
  function validate(dir: string, args: string[]) {
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main', '--json', ...args], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    return { report: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr, status: result.status }
  }
  type Report = {
    templates: {
      template: string
      items: { kind: string; name: string; locale: string | null; issues: { validator: string; message: string }[] }[]
    }[]
    alreadyBroken?: { templates: Report['templates'] }
  }
  const renderItems = (templates: Report['templates'], template: string) =>
    (templates.find(t => t.template === template)?.items ?? [])
      .filter(i => i.issues.some(issue => issue.validator === 'render'))
      .map(i => `${i.kind}:${i.name}${i.locale ? `:${i.locale}` : ''}`)

  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  it('fails on a changed template that throws, naming the item, language, template and error', () => {
    const dir = repo()
    throwing(dir, 'hero', 'items is empty')
    const { report, status } = validate(dir, ['--render', '--base', 'HEAD'])
    expect(status).toBe(1)
    const items = renderItems((report as Report).templates, 'hero')
    expect(items).toContain('page:home')
    expect(items).toContain('page:home:ja')
    const home = (report as Report).templates.find(t => t.template === 'hero')!.items.find(i => i.name === 'home')!
    expect(home.issues.find(i => i.validator === 'render')!.message).toBe(
      '`hero` throws when rendering: items is empty',
    )
  })

  it('renders the pages that use a changed template through a fragment', () => {
    const dir = repo()
    throwing(dir, 'logo', 'logo broke')
    const { report, status } = validate(dir, ['--render', '--base', 'HEAD'])
    expect(status).toBe(1)
    const items = renderItems((report as Report).templates, 'logo')
    // logo is in @header, and every page bakes @header in.
    expect(items).toEqual(expect.arrayContaining(['fragment:header', 'page:home', 'page:about']))
  }, 60_000)

  it("doesn't render an unchanged template under --base", () => {
    const dir = repo(d => {
      throwing(d, 'banner', 'banner was already broken')
      recording(d, 'card')
    })
    // Change one template so the run has something to render.
    recording(dir, 'hero')
    const { report, status } = validate(dir, ['--render', '--base', 'HEAD'])
    expect(renderItems((report as Report).templates, 'banner')).toEqual([])
    expect(status).toBe(0)
    const log = readFileSync(join(dir, 'renders.log'), 'utf-8')
    expect(log).toContain('hero')
    expect(log).not.toContain('card')
  }, 60_000)

  it('runs no template without --render', () => {
    const dir = repo()
    recording(dir, 'hero')
    validate(dir, ['--base', 'HEAD'])
    expect(existsSync(join(dir, 'renders.log'))).toBe(false)
    validate(dir, ['--render', '--base', 'HEAD'])
    expect(existsSync(join(dir, 'renders.log'))).toBe(true)
  }, 60_000)

  it('lists a throw the base commit also has as already broken', () => {
    const dir = repo(d => throwing(d, 'hero', 'broken before'))
    // Reword the throw: hero changes, and still throws.
    const path = join(dir, 'templates/hero/index.ts')
    writeFileSync(path, readFileSync(path, 'utf-8').replace('broken before', 'broken differently now'))
    const { report, status } = validate(dir, ['--render', '--base', 'HEAD'])
    expect(status).toBe(0)
    expect(renderItems((report as Report).templates, 'hero')).toEqual([])
    expect(renderItems((report as Report).alreadyBroken!.templates, 'hero')).toContain('page:home')
  }, 60_000)
})
