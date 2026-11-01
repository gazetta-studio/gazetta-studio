import { createRoute, z } from '@hono/zod-openapi'
import { join } from 'node:path'
import { createFilesystemProvider } from '../../providers/filesystem.js'
import type { SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { apiApp, json, problems } from '../openapi.js'
import { FieldSummarySchema } from '../schemas/fields.js'
import { TargetQuerySchema } from '../schemas/target-query.js'

const FIELD_EXTENSIONS = ['.ts', '.tsx']

const listFields = createRoute({
  method: 'get',
  path: '/fields',
  summary: "The project's custom fields",
  middleware: [requireCapability('read:pages')] as const,
  request: { query: TargetQuerySchema },
  responses: {
    200: json(z.array(FieldSummarySchema), 'The custom fields'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
  },
})

export function fieldRoutes(resolve: SourceContextResolver, adminDir?: string) {
  const app = apiApp()
  // Custom fields live at project level, outside target content storage.
  const storage = createFilesystemProvider()

  app.openapi(listFields, async c => {
    // projectSiteDir is target-invariant (it's the on-disk project path).
    // We still go through resolve() so the single source-lookup codepath
    // serves this route too — keeps the handler shape uniform.
    const source = await resolve(c.req.valid('query').target)
    const fieldsDir = join(adminDir ?? join(source.projectSiteDir, 'admin'), 'fields')

    if (!(await storage.exists(fieldsDir))) return c.json([], 200)

    const entries = await storage.readDir(fieldsDir)
    const fields = entries
      .filter(e => !e.isDirectory && FIELD_EXTENSIONS.some(ext => e.name.endsWith(ext)))
      .map(e => {
        const name = e.name.replace(/\.(ts|tsx)$/, '')
        return { name, path: join(fieldsDir, e.name) }
      })
    return c.json(fields, 200)
  })

  return app
}
