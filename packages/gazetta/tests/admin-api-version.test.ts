/**
 * `GET /api/version` (design-agent-access.md Q43): the supported majors
 * for anyone, the exact gazetta version only for a signed-in caller.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { VersionResponseSchema } from '../src/admin-api/schemas/version.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function appWith(admin?: SiteManifest['admin']) {
  const storage = memoryStorage()
  const targetConfigs = { local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true } }
  const manifest: SiteManifest = { name: 'test-site', targets: targetConfigs, ...(admin ? { admin } : {}) }
  return createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest }),
    siteDir: '/p',
    templatesDir: '/p/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
}

const forwardedUser = { auth: { trust: 'forwarded-user' as const, allowAnyOrigin: true } }
const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }
).version

describe('GET /api/version', () => {
  it('lists the majors, without the exact version, to a caller nobody identified', async () => {
    const res = await appWith(forwardedUser).request('/api/version')
    expect(res.status).toBe(200)
    expect(VersionResponseSchema.strict().parse(await res.json())).toEqual({ majors: ['v1'] })
  })

  it('adds the exact gazetta version for a signed-in caller', async () => {
    const res = await appWith(forwardedUser).request('/api/version', { headers: { 'X-Forwarded-User': 'alice' } })
    expect(VersionResponseSchema.parse(await res.json())).toEqual({ majors: ['v1'], version: packageVersion })
  })

  it('answers outside the major, not under /api/v1', async () => {
    expect((await appWith().request('/api/v1/version')).status).toBe(404)
  })
})
