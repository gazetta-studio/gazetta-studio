/**
 * The admin API's OpenAPI document as gz's client is generated from it
 * (design-agent-access.md Q8): served at the root, so paths start /api/v1.
 */
import { createAdminApp } from '../../src/admin-api/index.js'
import { OPENAPI_PATH } from '../../src/admin-api/openapi.js'
import { createSourceContext } from '../../src/admin-api/source-context.js'
import { memoryStorage } from './memory-storage.js'
import { starterTemplatesDir } from './starter.js'

export async function openApiDocumentJson(): Promise<string> {
  const storage = memoryStorage()
  const local = { storage, type: 'esi' as const, environment: 'local' as const, editable: true }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/project',
    manifest: { name: 'site', targets: { local } },
  })
  const app = createAdminApp({
    source,
    siteDir: '/project',
    templatesDir: starterTemplatesDir,
    targets: new Map([['local', storage]]),
    targetConfigs: { local },
    disableCacheStatsLogger: true,
  })
  const res = await app.request(OPENAPI_PATH)
  if (res.status !== 200) throw new Error(`OpenAPI document: HTTP ${res.status}`)
  return `${JSON.stringify(await res.json(), null, 2)}\n`
}
