/**
 * Input that fails a route's schema is answered as a problem+json 400
 * before the handler runs (design-agent-access.md Q5, #1674): one request
 * per route group, each checked to write nothing.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { ErrorResponseSchema } from '../src/admin-api/schemas/error.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function buildApp() {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'pages/home/page.json': JSON.stringify({ template: 'page-default', components: [] }),
    'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
  })
  const localConfig = { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true }
  const stagingConfig = { storage: targetStorage, type: 'static' as const, environment: 'staging' as const }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: { local: localConfig, staging: stagingConfig } },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: { local: localConfig, staging: stagingConfig },
    disableCacheStatsLogger: true,
  })
  return { app, sourceStorage, targetStorage }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const snapshot = (s: ReturnType<typeof memoryStorage>) =>
  [...s.dump()].map(([k, v]) => `${k}:${Buffer.from(v).toString('base64')}`).sort()

// `issues` is false where a route keeps its own pinned message, checked
// in middleware before the body validator (still before the handler).
const INVALID: Array<[group: string, path: string, init: RequestInit, issues?: false]> = [
  ['pages: save with content as a list', '/api/pages/home', json('PUT', { content: [] })],
  ['fragments: save with components as a string', '/api/fragments/header', json('PUT', { components: 'x' })],
  ['pages: create with a numeric name', '/api/pages', json('POST', { name: 5, template: 'page-default' })],
  ['publish: items as a string', '/api/publish', json('POST', { items: 'pages/home', targets: ['staging'] })],
  ['fetch: source as a number', '/api/fetch', json('POST', { source: 5 })],
  ['archive: aliasOf as a number', '/api/pages/home/archive', json('POST', { aliasOf: 5 })],
  ['alias: aliasOf as a list', '/api/pages/home/alias', json('PATCH', { aliasOf: [] })],
  ['rename: to as a number', '/api/pages/home/rename', json('POST', { to: 5 })],
  ['redirects: from as a number', '/api/page-redirects', json('POST', { from: 5, to: 'home' })],
  ['assets: metadata with alt as a number', '/api/assets/hero', json('PATCH', { alt: 5 }), false],
]

describe('input that fails its schema', () => {
  it.each(INVALID)('%s: problem+json 400, nothing written', async (_group, path, init, issues) => {
    const { app, sourceStorage, targetStorage } = buildApp()
    const before = [snapshot(sourceStorage), snapshot(targetStorage)]
    const res = await app.request(path, init)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
    const body = ErrorResponseSchema.parse(await res.json())
    if (issues !== false) expect(Array.isArray(body.issues) && body.issues.length > 0, JSON.stringify(body)).toBe(true)
    expect([snapshot(sourceStorage), snapshot(targetStorage)]).toEqual(before)
  })
})

describe('asset bodies without the declared content type', () => {
  it.each([
    ['metadata body without Content-Type', '/api/assets/hero', { method: 'PATCH', body: '{"alt":"x"}' }, 415],
    [
      'metadata with an empty JSON body',
      '/api/assets/hero',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '' },
      400,
    ],
    ['upload without a body', '/api/assets', { method: 'POST' }, 400],
    ['language version without a body', '/api/assets/hero/locale-bytes?locale=fr', { method: 'POST' }, 400],
  ] as Array<[string, string, RequestInit, number]>)(
    '%s: refused as a problem, nothing written',
    async (_name, path, init, status) => {
      const { app, sourceStorage, targetStorage } = buildApp()
      const before = [snapshot(sourceStorage), snapshot(targetStorage)]
      const res = await app.request(path, init)
      expect(res.status).toBe(status)
      expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
      expect([snapshot(sourceStorage), snapshot(targetStorage)]).toEqual(before)
    },
  )

  it('documents the asset bodies as required', async () => {
    const { app } = buildApp()
    const doc = (await (await app.request('/api/openapi.json')).json()) as {
      paths: Record<string, Record<string, { requestBody?: { required?: boolean } }>>
    }
    expect(doc.paths['/api/assets/{name}'].patch.requestBody?.required).toBe(true)
    expect(doc.paths['/api/assets'].post.requestBody?.required).toBe(true)
    expect(doc.paths['/api/assets/{name}/locale-bytes'].post.requestBody?.required).toBe(true)
  })
})

describe('unversioned routes in the document', () => {
  it('marks the dev and preview routes unversioned, and no /api route', async () => {
    const { app } = buildApp()
    const doc = (await (await app.request('/api/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-gazetta-unversioned'?: boolean } | unknown>>
    }
    const unversioned: string[] = []
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if ((op as { 'x-gazetta-unversioned'?: boolean })['x-gazetta-unversioned'])
          unversioned.push(`${method} ${path}`)
      }
    }
    expect(unversioned.sort()).toEqual(['get /__reload', 'get /__validation', 'get /preview/*', 'post /preview/*'])
  })
})
