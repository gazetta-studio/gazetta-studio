import { createRoute } from '@hono/zod-openapi'
import type { SourceContextResolver } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { apiApp, json, problems } from '../openapi.js'
import { SiteManifestSchema } from '../schemas/site.js'
import { TargetQuerySchema } from '../schemas/target-query.js'

const getSite = createRoute({
  method: 'get',
  path: '/api/site',
  summary: "The site's manifest",
  middleware: [requireCapability('read:pages')] as const,
  request: { query: TargetQuerySchema },
  responses: {
    200: json(SiteManifestSchema, 'The site manifest'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
  },
})

export function siteRoutes(resolve: SourceContextResolver) {
  const app = apiApp()

  app.openapi(getSite, async c => {
    const source = await resolve(c.req.valid('query').target)
    // Return the project-level manifest if available on the source context.
    if (source.manifest) return c.json(source.manifest, 200)
    // Last resort: read from target content root.
    try {
      const site = await loadSiteFromSource(source)
      return c.json(site.manifest, 200)
    } catch {
      return c.json({ name: '(empty)', targets: {} }, 200)
    }
  })

  return app
}
