/**
 * The OpenAPI document at /api/v1/openapi.json (design-agent-access.md Q5,
 * Q42, Q44): it lists exactly the /api routes the admin app registers, so a
 * route added without a schema fails here, and every versioned route sits
 * under /api/v1.
 */
import { Validator } from '@seriousme/openapi-schema-validator'
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { OPENAPI_PATH, openApiPath } from '../src/admin-api/openapi.js'
import { PROBLEM_CONTENT_TYPE } from '../src/admin-api/problem.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function buildApp() {
  const sourceStorage = memoryStorage()
  const localConfig = { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: { local: localConfig } },
  })
  return createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([['local', sourceStorage]]),
    targetConfigs: { local: localConfig },
    disableCacheStatsLogger: true,
  })
}

type OpenApiDocument = {
  openapi: string
  servers: Array<{ url: string }>
  paths: Record<string, Record<string, { 'x-gazetta-unversioned'?: boolean }>>
}

async function documentOf(app: ReturnType<typeof buildApp>): Promise<OpenApiDocument> {
  const res = await app.request(OPENAPI_PATH)
  expect(res.status).toBe(200)
  return (await res.json()) as OpenApiDocument
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** `METHOD /path` for every /api route the app registers (handlers, not middleware). */
function registeredRoutes(app: ReturnType<typeof buildApp>): Set<string> {
  const out = new Set<string>()
  for (const r of app.routes) {
    const method = r.method.toLowerCase()
    if (!METHODS.includes(method)) continue
    if (!r.path.startsWith('/api/') || r.path === '/api/*' || r.path === OPENAPI_PATH) continue
    out.add(`${method.toUpperCase()} ${openApiPath(r.path)}`)
  }
  return out
}

/** `METHOD /path` for every operation in the document. */
function documentedRoutes(doc: OpenApiDocument): Set<string> {
  const out = new Set<string>()
  for (const [path, ops] of Object.entries(doc.paths)) {
    if (!path.startsWith('/api/')) continue
    for (const method of Object.keys(ops)) {
      if (METHODS.includes(method)) out.add(`${method.toUpperCase()} ${path}`)
    }
  }
  return out
}

describe('GET /api/v1/openapi.json', () => {
  it('is an OpenAPI 3.1 document whose server URL is the admin mount', async () => {
    const doc = await documentOf(buildApp())
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.servers).toEqual([{ url: '/' }])
  })

  it('validates against the OpenAPI 3.1 schema', async () => {
    const result = await new Validator().validate(await documentOf(buildApp()))
    expect(result.errors ?? []).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('writes paths in OpenAPI syntax', async () => {
    const paths = Object.keys((await documentOf(buildApp())).paths)
    expect(paths.filter(p => p.includes(':'))).toEqual([])
    expect(paths).toContain('/api/v1/pages/{name}')
  })

  it('puts every versioned route under /api/v1', async () => {
    const doc = await documentOf(buildApp())
    const outside = Object.entries(doc.paths)
      .filter(([path]) => !path.startsWith('/api/v1/'))
      .filter(([, ops]) => !Object.values(ops).every(op => op['x-gazetta-unversioned']))
      .map(([path]) => path)
    // `/api/version` sits outside the major so a client can ask before it picks one (Q43).
    expect(outside).toEqual(['/api/version'])
  })

  it('lists exactly the /api routes the app registers', async () => {
    const app = buildApp()
    const doc = await documentOf(app)
    const registered = registeredRoutes(app)
    const documented = documentedRoutes(doc)
    expect({
      notDocumented: [...registered].filter(r => !documented.has(r)).sort(),
      notRegistered: [...documented].filter(r => !registered.has(r)).sort(),
    }).toEqual({ notDocumented: [], notRegistered: [] })
  })
})

describe('unprefixed /api paths', () => {
  it.each([
    ['GET', '/api/pages'],
    ['GET', '/api/openapi.json'],
    ['PUT', '/api/pages/home'],
  ])('%s %s answers a problem 404', async (method, path) => {
    const res = await buildApp().request(path, { method })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
  })

  it('answers under /api/v1', async () => {
    expect((await buildApp().request('/api/v1/pages')).status).toBe(200)
  })
})
