import { Hono } from 'hono'
import { join } from 'node:path'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { getType } from '../../types.js'
import { compareTargets } from '../../compare.js'
import type { TemplateInfo } from '../../templates-scan.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'

export function compareRoutes(
  resolve: SourceContextResolver,
  preInitTargets?: Map<string, StorageProvider>,
  targetConfigs?: Record<string, TargetConfig>,
  templatesDir?: string,
  scanTemplatesInjected?: (templatesDir: string, projectRoot: string) => Promise<TemplateInfo[]>,
) {
  const app = new Hono()

  let targets: Map<string, StorageProvider> | null = preInitTargets ?? null
  let targetsInitPromise: Promise<Map<string, StorageProvider>> | null = null

  async function getTargets(projectSiteDir: string): Promise<Map<string, StorageProvider>> {
    if (targets) return targets
    if (!targetConfigs || Object.keys(targetConfigs).length === 0) {
      targets = new Map()
      return targets
    }
    if (!targetsInitPromise) {
      const { createTargetRegistry } = await import('../../targets.js')
      targetsInitPromise = createTargetRegistry(targetConfigs)
        .then(t => {
          targets = t
          return t
        })
        .catch(() => {
          targets = new Map()
          return new Map()
        })
    }
    return targetsInitPromise
  }

  app.get('/api/compare', requireCapability('read:pages'), async c => {
    // `target` = compare destination (what we're diffing against)
    // `source` = source of the compare (which editable target to read from);
    //           defaults to the resolver's default editable target
    const targetName = c.req.query('target')
    if (!targetName) return c.json({ error: 'Missing "target" query parameter' }, 400)

    const source = await resolve(c.req.query('source'))
    const { projectSiteDir } = source

    const t = await getTargets(projectSiteDir)
    const targetStorage = t.get(targetName)
    if (!targetStorage) return c.json({ error: `Unknown target: ${targetName}` }, 400)

    const tdir = templatesDir ?? join(projectSiteDir, 'templates')
    const projectRoot = projectSiteDir.replace(/[\\/]sites[\\/][^\\/]+$/, '')

    const targetConfig = targetConfigs?.[targetName]
    const type = targetConfig ? getType(targetConfig) : 'dynamic'

    try {
      const result = await compareTargets({
        sourceRoot: source.contentRoot,
        target: targetStorage,
        templatesDir: tdir,
        projectRoot,
        type,
        scanTemplates: scanTemplatesInjected,
        manifest: source.manifest,
      })
      return c.json(result)
    } catch (err) {
      return c.json({ error: `Compare failed: ${(err as Error).message}` }, 500)
    }
  })

  return app
}
