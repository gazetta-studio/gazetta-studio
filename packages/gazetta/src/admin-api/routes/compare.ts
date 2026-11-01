import { createRoute } from '@hono/zod-openapi'
import { join } from 'node:path'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { getType } from '../../types.js'
import { compareTargets } from '../../compare.js'
import type { TemplateInfo } from '../../templates-scan.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { problem } from '../problem.js'
import { apiApp, json, problems } from '../openapi.js'
import { CompareQuerySchema, CompareResultSchema } from '../schemas/compare.js'

const compare = createRoute({
  method: 'get',
  path: '/compare',
  summary: 'What differs between the source and a target',
  middleware: [requireCapability('read:pages')] as const,
  request: { query: CompareQuerySchema },
  responses: {
    200: json(CompareResultSchema, 'Items added, modified, deleted and unchanged on the target'),
    ...problems({ 400: ['BAD_REQUEST'], 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 500: ['INTERNAL'] }),
  },
})

export function compareRoutes(
  resolve: SourceContextResolver,
  preInitTargets?: Map<string, StorageProvider>,
  targetConfigs?: Record<string, TargetConfig>,
  templatesDir?: string,
  scanTemplatesInjected?: (templatesDir: string, projectRoot: string) => Promise<TemplateInfo[]>,
) {
  const app = apiApp()

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

  app.openapi(compare, async c => {
    const query = c.req.valid('query')
    // `target` = compare destination (what we're diffing against)
    // `source` = source of the compare (which editable target to read from);
    //           defaults to the resolver's default editable target
    const targetName = query.target
    if (!targetName) return problem(c, 400, 'BAD_REQUEST', 'Missing "target" query parameter')

    const source = await resolve(query.source)
    const { projectSiteDir } = source

    const t = await getTargets(projectSiteDir)
    const targetStorage = t.get(targetName)
    if (!targetStorage) return problem(c, 400, 'BAD_REQUEST', `Unknown target: ${targetName}`)

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
      return c.json(result, 200)
    } catch (err) {
      return problem(c, 500, 'INTERNAL', `Compare failed: ${(err as Error).message}`)
    }
  })

  return app
}
