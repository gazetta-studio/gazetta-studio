/**
 * Saving content with script in a plain text field is refused for pages and
 * fragments, and nothing is written (design-content-trust.md Q2). Script an
 * item already held doesn't block a save of another field (Q3).
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

let templatesDir: string
beforeAll(async () => {
  const tmp = resolve(__dirname, '../../../.tmp')
  await mkdir(tmp, { recursive: true })
  templatesDir = join(await mkdtemp(join(tmp, 'save-script-')), 'templates')
  for (const name of ['hero', 'page-default']) {
    await cp(join(starterTemplatesDir, name), join(templatesDir, name), { recursive: true })
  }
  await mkdir(join(templatesDir, 'loose'), { recursive: true })
  await writeFile(
    join(templatesDir, 'loose', 'index.ts'),
    `import { z } from 'zod'
export const schema = z.object({ data: z.any().optional(), meta: z.record(z.string(), z.unknown()).optional() })
export default () => ({ html: '', css: '', js: '' })
`,
  )
})
afterAll(async () => {
  await rm(resolve(templatesDir, '..'), { recursive: true, force: true })
})

const alice = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'admins' }
const hero = (content: Record<string, unknown>) => ({ name: 'hero', template: 'hero', content })
const OLD_SCRIPT = '<img src=x onerror=alert(1)>'

function setup() {
  const local = memoryStorage()
  local.seed({
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      content: {},
      components: [hero({ title: 'Hello' })],
    }),
    'pages/legacy/page.json': JSON.stringify({
      template: 'page-default',
      content: {},
      components: [hero({ title: OLD_SCRIPT, subtitle: 'old' })],
    }),
    'fragments/banner/fragment.json': JSON.stringify({ template: 'hero', content: { title: 'Banner' } }),
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
  return { app, local }
}

const put = (app: ReturnType<typeof setup>['app'], path: string, body: unknown) =>
  app.request(`/api/v1/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...alice },
    body: JSON.stringify(body),
  })

type Body = { code: string; issues: Array<{ validator: string; message: string; field?: string }> }
const scriptIssues = async (res: Response) =>
  ((await res.json()) as Body).issues.filter(i => i.validator === 'script-in-text')

describe('save refuses script in plain text fields', () => {
  it('answers 409 for a page and writes nothing', async () => {
    const { app, local } = setup()
    const stored = await local.readFile('pages/home/page.json')
    const res = await put(app, 'pages/home', { components: [hero({ title: OLD_SCRIPT })] })
    expect(res.status).toBe(409)
    expect(((await res.clone().json()) as Body).code).toBe('VALIDATION_FAILED')
    expect(await scriptIssues(res)).toEqual([
      expect.objectContaining({ message: "Script isn't allowed in title: remove onerror.", field: 'title' }),
    ])
    expect(await local.readFile('pages/home/page.json')).toBe(stored)
  })

  it('answers 409 for a fragment with an unsafe address and writes nothing', async () => {
    const { app, local } = setup()
    const stored = await local.readFile('fragments/banner/fragment.json')
    const res = await put(app, 'fragments/banner', { content: { title: 'Banner', subtitle: 'javascript:alert(1)' } })
    expect(res.status).toBe(409)
    expect((await scriptIssues(res)).map(i => i.message)).toEqual([
      "Script isn't allowed in subtitle: remove javascript:.",
    ])
    expect(await local.readFile('fragments/banner/fragment.json')).toBe(stored)
  })

  it('answers 409 for script in values no schema describes and writes nothing', async () => {
    const { app, local } = setup()
    const stored = await local.readFile('pages/home/page.json')
    const res = await put(app, 'pages/home', {
      components: [
        hero({ title: 'Hello', extra: '<img src=x onerror=y>' }),
        {
          name: 'loose',
          template: 'loose',
          content: { data: { links: [{ href: 'javascript:x' }] }, meta: { nested: { caption: '<script>x</script>' } } },
        },
      ],
    })
    expect(res.status).toBe(409)
    expect((await scriptIssues(res)).map(i => i.field)).toEqual(['extra', 'data.links.0.href', 'meta.nested.caption'])
    expect(await local.readFile('pages/home/page.json')).toBe(stored)
  })

  it('saves plain text that only looks like markup', async () => {
    const { app } = setup()
    const res = await put(app, 'pages/home', { components: [hero({ title: 'a < b', subtitle: '<b>bold</b>' })] })
    expect(res.status).toBe(200)
  })

  it('saves an edit of another field on an item that already holds script', async () => {
    const { app, local } = setup()
    const res = await put(app, 'pages/legacy', { components: [hero({ title: OLD_SCRIPT, subtitle: 'new' })] })
    expect(res.status).toBe(200)
    const saved = JSON.parse(await local.readFile('pages/legacy/page.json'))
    expect(saved.components[0].content).toEqual({ title: OLD_SCRIPT, subtitle: 'new' })
  })
})
