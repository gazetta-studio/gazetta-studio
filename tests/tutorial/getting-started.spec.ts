/**
 * Runs the tutorial in docs/getting-started.md the way a reader would
 * (design-tutorial.md, "The CI check").
 *
 * The tarball under test comes from GAZETTA_TARBALL (CI's `pack` artifact)
 * or, when unset, from `npm pack` in packages/gazetta, which needs
 * `npm run build` and `npm run build:admin -w packages/gazetta` first. A
 * Verdaccio registry serves that tarball as `gazetta` and proxies every other
 * package to npmjs, so the tutorial's own commands (`npx gazetta init`, the
 * `npm install` it runs) install the code under test, not npm's release.
 *
 * The shell steps below must match the tutorial's shell blocks exactly; the
 * first test fails when either changes without the other.
 */
import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PublishPanelPom } from '../e2e/pages/PublishPanel'
import { ComponentTreePom } from '../e2e/pages/ComponentTree'
import { expectSaveSettled } from '../e2e/helpers'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tutorialPath = join(repoRoot, 'docs/getting-started.md')

const VERDACCIO = 'verdaccio@6.10.5'
const REGISTRY_PORT = 4873
const REGISTRY = `http://127.0.0.1:${REGISTRY_PORT}/`
const SITE = 'http://localhost:3000'
const STAGING = 'http://localhost:3001'
const ORIGINAL_TITLE = 'Welcome to my-site'
const NEW_TITLE = 'Hello from the tutorial'

interface ShellStep {
  /** The tutorial heading the shell block sits under. */
  heading: string
  commands: string[]
}

const SHELL_STEPS: ShellStep[] = [
  { heading: '1. Create a site', commands: ['npx gazetta init my-site', 'cd my-site'] },
  { heading: '2. Start the dev server', commands: ['npx gazetta dev'] },
  { heading: '4. Look at staging as a visitor', commands: ['npx gazetta serve staging --port 3001'] },
]

/** The tutorial's shell blocks, in order, each with the heading above it. */
function extractShellSteps(markdown: string): ShellStep[] {
  const steps: ShellStep[] = []
  let heading = ''
  let block: string[] | null = null
  for (const line of markdown.split('\n')) {
    if (block) {
      if (line.startsWith('```')) {
        steps.push({ heading, commands: block })
        block = null
      } else if (line.trim()) block.push(line.trim())
      continue
    }
    const h = line.match(/^##\s+(.*)$/)
    if (h) heading = h[1].trim()
    else if (/^```(bash|sh|shell|console)\s*$/.test(line)) block = []
  }
  return steps
}

// A 64×40 PNG, the image the reader uploads in step 6.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAbklEQVRYhe2SAQkAURSD1slOl9ZQF2M8/mABVBY+Ty91AiZgvSK7kHeXOgETsF6RXci7S52ACVivyC7k3aVOwASsV2QX8u5SJ2AC1iuyC3l3qRMwAesV2YW8u9QJmID1iuxC3l3qBEzAekVevtAPXo3yxP8cQcYAAAAASUVORK5CYII=',
  'base64',
)

let work = ''
let env: NodeJS.ProcessEnv = {}
let tarball = ''
let cwd = ''
let registry: ChildProcess | undefined
let dev: ChildProcess | undefined
let serve: ChildProcess | undefined
let page: Page

/** The environment a reader's shell would have: no npm_* from `npm run`, our registry. */
function readerEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^npm_/i.test(k) && k !== 'INIT_CWD') clean[k] = v
  }
  return {
    ...clean,
    npm_config_registry: REGISTRY,
    npm_config_cache: join(work, 'npm-cache'),
    npm_config_userconfig: join(work, 'reader.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
}

function run(
  command: string,
  dir: string,
  extraEnv: NodeJS.ProcessEnv = env,
): Promise<{ code: number | null; output: string }> {
  return new Promise(res => {
    const child = spawn(command, { cwd: dir, env: extraEnv, shell: true })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    child.on('close', code => res({ code, output }))
  })
}

function background(command: string, dir: string, extraEnv: NodeJS.ProcessEnv = env): ChildProcess {
  const child = spawn(command, { cwd: dir, env: extraEnv, shell: true, detached: true })
  let output = ''
  child.stdout?.on('data', d => (output += d))
  child.stderr?.on('data', d => (output += d))
  child.on('exit', code => {
    if (code) console.error(`"${command}" exited with ${code}:\n${output}`)
  })
  return child
}

function stop(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

async function waitFor(url: string, child: ChildProcess, timeout = 120_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`process for ${url} exited with ${child.exitCode}`)
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${url} not ready after ${timeout} ms`)
}

async function html(url: string): Promise<string> {
  const r = await fetch(url, { cache: 'no-store' })
  return r.text()
}

/** Pack packages/gazetta unless CI handed us its tarball. */
async function findTarball(): Promise<string> {
  if (process.env.GAZETTA_TARBALL) return resolve(process.env.GAZETTA_TARBALL)
  const out = join(work, 'pack')
  await mkdir(out)
  const { code, output } = await run(
    `npm pack --silent --pack-destination "${out}"`,
    join(repoRoot, 'packages/gazetta'),
    {
      ...process.env,
    },
  )
  if (code !== 0) throw new Error(`npm pack failed:\n${output}`)
  const file = (await readdir(out)).find(f => f.endsWith('.tgz'))
  if (!file) throw new Error('npm pack produced no tarball')
  return join(out, file)
}

/** Start Verdaccio with gazetta local-only, and publish the tarball to it. */
async function startRegistry(): Promise<void> {
  const dir = join(work, 'verdaccio')
  await mkdir(dir)
  const config = join(dir, 'config.yaml')
  await writeFile(
    config,
    `storage: ${join(dir, 'storage')}
auth:
  htpasswd:
    file: ${join(dir, 'htpasswd')}
    max_users: 10
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  'gazetta':
    access: $all
    publish: $authenticated
  '**':
    access: $all
    publish: $authenticated
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
`,
  )
  // Verdaccio itself comes from npmjs, outside the reader's environment.
  registry = background(`npx -y ${VERDACCIO} --config "${config}" --listen 127.0.0.1:${REGISTRY_PORT}`, dir, {
    ...readerEnv(),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_cache: join(work, 'tool-cache'),
  })
  await waitFor(`${REGISTRY}-/ping`, registry)

  const user = await fetch(`${REGISTRY}-/user/org.couchdb.user:tutorial`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'tutorial', password: 'tutorial-password' }),
  })
  const { token } = (await user.json()) as { token: string }
  const npmrc = join(work, 'publisher.npmrc')
  await writeFile(npmrc, `//127.0.0.1:${REGISTRY_PORT}/:_authToken=${token}\n`)
  const published = await run(`npm publish "${tarball}" --registry ${REGISTRY} --ignore-scripts`, work, {
    ...readerEnv(),
    npm_config_userconfig: npmrc,
  })
  if (published.code !== 0) throw new Error(`publishing the tarball failed:\n${published.output}`)
}

async function sha512(file: string): Promise<string> {
  return `sha512-${createHash('sha512')
    .update(await readFile(file))
    .digest('base64')}`
}

test.describe.configure({ mode: 'serial' })

test('the tutorial shell blocks match the steps this test runs', async () => {
  const markdown = await readFile(tutorialPath, 'utf8')
  expect(extractShellSteps(markdown)).toEqual(SHELL_STEPS)
})

test.describe('tutorial', () => {
  test.beforeAll(async () => {
    test.setTimeout(10 * 60_000)
    work = await mkdtemp(join(tmpdir(), 'gazetta-tutorial-'))
    await writeFile(join(work, 'reader.npmrc'), '')
    env = readerEnv()
    cwd = join(work, 'reader')
    await mkdir(cwd)
    tarball = await findTarball()
    await startRegistry()
  })

  test.afterAll(async () => {
    await page?.close()
    stop(serve)
    stop(dev)
    stop(registry)
    if (work && !process.env.KEEP_TUTORIAL_DIR) await rm(work, { recursive: true, force: true })
  })

  test('steps 1–7: create, run, publish, edit, add an image, publish again', async ({ browser }) => {
    const [create, devStep, serveStep] = SHELL_STEPS

    await test.step(create.heading, async () => {
      const [init, cd] = create.commands
      const { code, output } = await run(init, cwd)
      expect(code, output).toBe(0)
      expect(output).not.toContain('npm install failed')
      expect(cd).toBe('cd my-site')
      cwd = join(cwd, 'my-site')
      const config = await readFile(join(cwd, 'sites/main/site.config.ts'), 'utf8')
      expect(config).toMatch(/\blocal:\s*{/)
      expect(config).toMatch(/\bstaging:\s*{/)
      // The site installed the tarball under test, not a release from npm.
      const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'))
      const installed = lock.packages['node_modules/gazetta']
      expect(installed.resolved).toContain(`127.0.0.1:${REGISTRY_PORT}`)
      expect(installed.integrity).toBe(await sha512(tarball))
    })

    await test.step(devStep.heading, async () => {
      dev = background(devStep.commands[0], cwd)
      await waitFor('http://127.0.0.1:3000/admin', dev)
      expect(await html('http://127.0.0.1:3000/')).toContain(ORIGINAL_TITLE)
    })

    // The browser opens only once the admin is up, not during the install.
    page = await browser.newPage()
    const panel = new PublishPanelPom(page)

    async function publishToStaging(): Promise<void> {
      await panel.open()
      await expect(panel.root).toBeVisible()
      await panel.pickDestination('staging')
      await expect(panel.item('pages/home')).toBeVisible({ timeout: 30_000 })
      await panel.publish()
      await expect(panel.result('staging')).toHaveClass(/success/, { timeout: 60_000 })
    }

    await test.step('3. Publish to staging', async () => {
      await page.goto(`${SITE}/admin`)
      await publishToStaging()
      await panel.doneButton.click()
      await expect(panel.root).not.toBeVisible()
    })

    await test.step(serveStep.heading, async () => {
      serve = background(serveStep.commands[0], cwd)
      await waitFor(STAGING, serve)
      expect(await html(STAGING)).toContain(ORIGINAL_TITLE)
    })

    const save = page.locator('[data-testid="save-btn"]')

    await test.step('5. Edit the home page', async () => {
      await page.goto(`${SITE}/admin/pages/home/edit`)
      await new ComponentTreePom(page).open('hero')
      const title = page.locator('input[name="root_title"]').first()
      await title.fill(NEW_TITLE)
      await save.click()
      await expectSaveSettled(save, { timeout: 15_000 })
      await expect.poll(() => html(`${SITE}/`)).toContain(NEW_TITLE)
      expect(await html(STAGING)).toContain(ORIGINAL_TITLE)
    })

    await test.step('6. Add an image', async () => {
      await page.locator('[data-testid="asset-widget-pick"]').click()
      const picker = page.locator('[data-testid="asset-picker"]')
      await expect(picker).toBeVisible()
      await picker
        .locator('[data-testid="asset-upload-input"]')
        .setInputFiles({ name: 'tutorial-photo.png', mimeType: 'image/png', buffer: PNG })
      // The list refreshes after the upload, which can drop a selection
      // made before it settles; click until Select is enabled.
      const card = picker.locator('[data-testid="asset-card-tutorial-photo"]')
      const select = picker.locator('[data-testid="asset-picker-confirm"]')
      await expect(async () => {
        await card.click()
        await expect(select).toBeEnabled({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
      await select.click()
      await expect(picker).not.toBeVisible()
      await save.click()
      await expectSaveSettled(save, { timeout: 15_000 })
      await expect.poll(() => html(`${SITE}/`)).toMatch(/<section class="hero">\s*<img /)
      expect(await html(STAGING)).not.toMatch(/<section class="hero">\s*<img /)
    })

    await test.step('7. Publish the change', async () => {
      await publishToStaging()
      const live = await html(STAGING)
      expect(live).toContain(NEW_TITLE)
      const src = live.match(/<section class="hero">\s*<img src="([^"]+)"/)?.[1]
      expect(src, 'staging serves the hero image').toBeTruthy()
      const image = await fetch(new URL(src as string, STAGING))
      expect(image.status).toBe(200)
      expect(image.headers.get('content-type')).toMatch(/^image\//)
    })

    expect(dev?.exitCode, 'gazetta dev is still running').toBeNull()
    expect(serve?.exitCode, 'gazetta serve is still running').toBeNull()
  })

  test('8. Undo the publish', async () => {
    // Undo on a publish destination restores manifests only, so staging
    // keeps serving the new title until publish undo ships (#1092).
    test.fail(true, 'Undo on a publish destination does not re-render yet (#1092)')
    await page.locator('[data-testid="publish-result-undo-staging"]').click()
    await expect.poll(() => html(STAGING), { timeout: 30_000 }).toContain(ORIGINAL_TITLE)
    expect(await html(STAGING)).not.toMatch(/<section class="hero">\s*<img /)
  })
})
