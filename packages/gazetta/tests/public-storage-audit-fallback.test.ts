/**
 * Public storage cut 4 (#1592, design-public-storage.md Q5): the admin's
 * audit log goes to the source if its storage is private, else to the
 * first private target in `site.config.ts` order, else nowhere, and a
 * publish then says its audit event wasn't kept.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { AUDIT_DROPPED_WARNING } from '../src/admin-api/routes/publish.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import type { SiteManifest, StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const auditFiles = (storage: MemoryStorage) => [...storage.dump().keys()].filter(p => p.startsWith('.gazetta/audit/'))

/** `configs` in site.config.ts order; `local` is the boot source. */
function appWith(configs: Record<string, TargetConfig>) {
  const local = configs.local.storage as MemoryStorage
  local.seed({ 'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout', content: {} }) })
  const manifest: SiteManifest = { name: 'test-site', targets: configs }
  return createAdminApp({
    source: createSourceContext({ storage: local, siteDir: '', projectSiteDir: '/p', manifest, targetName: 'local' }),
    siteDir: '/p',
    templatesDir: starterTemplatesDir,
    targets: new Map<string, StorageProvider>(Object.entries(configs).map(([name, c]) => [name, c.storage])),
    targetConfigs: configs,
    disableCacheStatsLogger: true,
  })
}

const target = (publicStorage: boolean, extra: Partial<TargetConfig> = {}): TargetConfig => ({
  storage: memoryStorage(),
  type: 'esi',
  environment: 'staging',
  publicStorage,
  ...extra,
})

async function publish(app: ReturnType<typeof appWith>, route: string) {
  const res = await app.request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: ['fragments/header'], targets: ['production'], source: 'local' }),
  })
  return res.text()
}

describe('where the admin keeps audit events', { timeout: 30_000 }, () => {
  it('on the source when its storage is private', async () => {
    const configs = { local: target(false, { editable: true }), backup: target(false), production: target(true) }
    const body = await publish(appWith(configs), '/api/v1/publish')
    expect(auditFiles(configs.local.storage as MemoryStorage)).not.toEqual([])
    expect(auditFiles(configs.backup.storage as MemoryStorage)).toEqual([])
    expect(body).not.toContain(AUDIT_DROPPED_WARNING)
  })

  it('on the first private target in config order when the source is public', async () => {
    const configs = {
      local: target(true),
      production: target(true),
      backup: target(false),
      archive: target(false),
    }
    const body = await publish(appWith(configs), '/api/v1/publish')
    expect(auditFiles(configs.backup.storage as MemoryStorage)).not.toEqual([])
    for (const name of ['local', 'production', 'archive'] as const) {
      expect(auditFiles(configs[name].storage as MemoryStorage)).toEqual([])
    }
    expect(body).not.toContain(AUDIT_DROPPED_WARNING)
  })

  it.each(['/api/v1/publish', '/api/v1/publish/stream'])(
    'nowhere when no target is private, and %s says so',
    async route => {
      const configs = { local: target(true), production: target(true) }
      const body = await publish(appWith(configs), route)
      for (const config of Object.values(configs)) expect(auditFiles(config.storage as MemoryStorage)).toEqual([])
      expect(body).toContain(AUDIT_DROPPED_WARNING)
    },
  )
})
