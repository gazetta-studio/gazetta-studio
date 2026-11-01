/**
 * Save rejects the schema problems it introduces (design-agent-access.md
 * Q49, cut 2): every component a save touches must pass its template's
 * schema, for every caller. Untouched components aren't checked.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { exportPKCS8 } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { generateSigningKeys } from '../src/auth/tokens/keys.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

// hero and page-default from the starter, plus `broken`, which exists but
// throws when loaded. Under the repo so the templates resolve zod.
let templatesDir: string
beforeAll(async () => {
  const tmp = resolve(__dirname, '../../../.tmp')
  await mkdir(tmp, { recursive: true })
  templatesDir = join(await mkdtemp(join(tmp, 'save-schema-')), 'templates')
  for (const name of ['hero', 'page-default']) {
    await cp(join(starterTemplatesDir, name), join(templatesDir, name), { recursive: true })
  }
  await mkdir(join(templatesDir, 'broken-save-schema'), { recursive: true })
  await writeFile(join(templatesDir, 'broken-save-schema', 'index.ts'), "throw new Error('boom')\n")
})
afterAll(async () => {
  await rm(resolve(templatesDir, '..'), { recursive: true, force: true })
})

beforeEach(async () => {
  vi.stubEnv('GAZETTA_SIGNING_KEY', await exportPKCS8((await generateSigningKeys()).current.privateKey))
})
afterEach(() => vi.unstubAllEnvs())

const alice = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'admins' }
const hero = (name: string, content: Record<string, unknown>, template = 'hero') => ({ name, template, content })

/** `home` holds a valid `hero` and an `intro` that's already invalid (no title). */
function setup() {
  const local = memoryStorage()
  const home = {
    template: 'page-default',
    content: {},
    components: [hero('hero', { title: 'Hello' }), hero('intro', {})],
  }
  local.seed({
    'pages/home/page.json': JSON.stringify(home),
    'pages/home/page.fr.json': JSON.stringify({ ...home, components: [hero('hero', { title: 'Bonjour' })] }),
  })
  const targetConfigs = {
    local: {
      storage: local,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
      publicStorage: false,
    },
  }
  const auth = {
    trust: 'forwarded-user' as const,
    allowAnyOrigin: true,
    roleMapping: { claim: 'groups', map: { admins: 'admin' }, defaultRole: 'editor' },
  }
  const manifest: SiteManifest = { name: 'site', targets: targetConfigs, admin: { auth } }
  const app = createAdminApp({
    source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir,
    targets: new Map<string, StorageProvider>([['local', local]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app }
}
type App = ReturnType<typeof setup>['app']

async function signIn(app: App): Promise<Record<string, string>> {
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const s = (await (await app.request('/api/v1/auth/logins', post({ machine: 'laptop' }))).json()) as {
    code: string
    pollSecret: string
  }
  await app.request(`/api/v1/auth/logins/${s.code}/approve`, { method: 'POST', headers: alice })
  const r = (await (
    await app.request(`/api/v1/auth/logins/${s.code}/redeem`, post({ pollSecret: s.pollSecret }))
  ).json()) as { token: string }
  return { 'Gazetta-Token': r.token }
}

const save = (app: App, components: unknown[], who: Record<string, string>, query = '') =>
  app.request(`/api/v1/pages/home${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...who },
    body: JSON.stringify({ components }),
  })

type Body = { code: string; issues: Array<{ validator: string; message: string; contentPath?: string }> }
const schemaIssues = async (res: Response) =>
  ((await res.json()) as Body).issues.filter(i => i.validator === 'schema-conformance')

describe('save checks the components it touches', () => {
  it.each([
    ['the browser', async () => alice],
    ['a token', signIn],
  ])('emptying a required field answers 409 with the field path, through %s', async (_who, who) => {
    const { app } = setup()
    const res = await save(app, [hero('hero', {}), hero('intro', {})], await who(app))
    expect(res.status).toBe(409)
    expect(((await res.clone().json()) as Body).code).toBe('VALIDATION_FAILED')
    const issues = await schemaIssues(res)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ contentPath: 'hero' })
    expect(issues[0]!.message).toMatch(/^title: /)
  })

  it('editing one component saves while another is already invalid', async () => {
    const { app } = setup()
    expect((await save(app, [hero('hero', { title: 'Changed' }), hero('intro', {})], alice)).status).toBe(200)
  })

  it('a new component with invalid content is refused', async () => {
    const { app } = setup()
    const res = await save(app, [hero('hero', { title: 'Hello' }), hero('intro', {}), hero('cta', {})], alice)
    expect(res.status).toBe(409)
    expect((await schemaIssues(res)).map(i => i.contentPath)).toEqual(['cta'])
  })

  it('reordering components without editing them saves', async () => {
    const { app } = setup()
    expect((await save(app, [hero('intro', {}), hero('hero', { title: 'Hello' })], alice)).status).toBe(200)
  })

  it('a language version is checked the same way', async () => {
    const { app } = setup()
    const res = await save(app, [hero('hero', {})], alice, '?locale=fr')
    expect(res.status).toBe(409)
    expect((await schemaIssues(res)).map(i => i.contentPath)).toEqual(['hero'])
    expect((await save(app, [hero('hero', { title: 'Salut' })], alice, '?locale=fr')).status).toBe(200)
  })

  it('a touched component whose template fails to load is refused, naming the template', async () => {
    const { app } = setup()
    const res = await save(
      app,
      [hero('hero', { title: 'Hello' }), hero('intro', {}), hero('x', { a: 1 }, 'broken-save-schema')],
      alice,
    )
    expect(res.status).toBe(409)
    const issues = await schemaIssues(res)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('Template "broken-save-schema" couldn\'t be loaded')
  })
})
