/**
 * Walks known error paths across the admin API and checks each answers
 * RFC 9457 problem+json with a code from `ErrorCodeSchema`
 * (design-agent-access.md Q45). Fails while any route still answers
 * `{ error }` or `{ code, message }`.
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
    'pages/home/page.json': JSON.stringify({ route: '/', template: 'page-default', components: [] }),
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
  return createAdminApp({
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
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

const ERROR_PATHS: Array<[label: string, path: string, init?: RequestInit]> = [
  ['an unknown API path', '/api/v1/no-such-route'],
  ['a missing page', '/api/v1/pages/no-such-page'],
  ['a missing fragment', '/api/v1/fragments/no-such-fragment'],
  ['a page create with no name', '/api/v1/pages', json('POST', {})],
  ['a stale page save', '/api/v1/pages/home', json('PUT', { components: [] }, { 'If-Match': '"not-the-etag"' })],
  ['a publish with no items', '/api/v1/publish', json('POST', { targets: ['staging'] })],
  ['a publish to an unknown target', '/api/v1/publish', json('POST', { items: ['pages/home'], targets: ['nope'] })],
  ['a compare against an unknown target', '/api/v1/compare?target=nope'],
  ['history of an unknown target', '/api/v1/history?target=nope'],
  ['a missing asset', '/api/v1/assets/no-such-asset'],
  ['deleting a missing asset', '/api/v1/assets/no-such-asset', { method: 'DELETE' }],
  ['a missing template schema', '/api/v1/templates/no-such-template/schema'],
  ['archiving a missing page', '/api/v1/pages/no-such-page/archive', json('POST', {})],
  ['purging a page that is not archived', '/api/v1/pages/home/purge', { method: 'DELETE' }],
  ['renaming a missing page', '/api/v1/pages/no-such-page/rename', json('POST', { newName: 'other' })],
]

describe('admin-API errors are problem+json', () => {
  it.each(ERROR_PATHS)('%s', async (_label, path, init) => {
    const res = await buildApp().request(path, init)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
    const body = ErrorResponseSchema.parse(await res.json())
    expect(body.status).toBe(res.status)
  })
})
