import { createRoute, z as zo } from '@hono/zod-openapi'
import { join } from 'node:path'
import { z } from 'zod'
import { loadTemplate, hasEditorFile } from '../../template-loader.js'
import { createFilesystemProvider } from '../../providers/filesystem.js'
import type { SourceContextResolver } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import { problem } from '../problem.js'
import type { ValidationScanner } from '../../validation/scanner.js'
import { computeTemplateImpact } from '../../validation/template-impact.js'
import { apiApp, json, problems } from '../openapi.js'
import {
  TemplateImpactResponseSchema,
  TemplateNameParamSchema,
  TemplateSchemaResponseSchema,
  TemplateSummarySchema,
} from '../schemas/templates.js'
import { TargetQuerySchema } from '../schemas/target-query.js'

const EDITOR_EXTENSIONS = ['.tsx', '.ts']

const listTemplates = createRoute({
  method: 'get',
  path: '/api/templates',
  summary: "The project's templates",
  middleware: [requireCapability('read:pages')] as const,
  request: { query: TargetQuerySchema },
  responses: {
    200: json(zo.array(TemplateSummarySchema), 'The templates'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'] }),
  },
})

const templateSchema = createRoute({
  method: 'get',
  path: '/api/templates/:name/schema',
  summary: "A template's content schema",
  middleware: [requireCapability('read:pages')] as const,
  request: { params: TemplateNameParamSchema, query: TargetQuerySchema },
  responses: {
    200: json(TemplateSchemaResponseSchema, 'The content schema as JSON Schema, with the editor and field locations'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 500: ['INTERNAL'] }),
  },
})

const templateImpact = createRoute({
  method: 'get',
  path: '/api/templates/:name/impact',
  summary: 'The pages and fragments that use a template, with their issues',
  middleware: [requireCapability('read:pages')] as const,
  request: { params: TemplateNameParamSchema, query: TargetQuerySchema },
  responses: {
    200: json(TemplateImpactResponseSchema, 'The items using the template'),
    ...problems({ 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'], 500: ['INTERNAL'] }),
  },
})

export interface TemplateRoutesOptions {
  /**
   * Validation scanner — used by `GET /api/templates/:name/impact` to
   * project the template's per-item issues. When omitted, the impact
   * endpoint reports all clean (no issues), which matches the
   * "validation disabled" boot path.
   */
  scanner?: ValidationScanner | null
}

export function templateRoutes(
  resolve: SourceContextResolver,
  templatesDir?: string,
  adminDir?: string,
  production?: boolean,
  opts: TemplateRoutesOptions = {},
) {
  const app = apiApp()
  // Templates and admin live at project level, outside target content storage.
  // Read them via a cwd-rooted filesystem provider and absolute paths.
  const storage = createFilesystemProvider()

  async function dirs(target: string | undefined) {
    const source = await resolve(target)
    const { projectSiteDir } = source
    const tplDir = templatesDir ?? join(projectSiteDir, 'templates')
    const admDir = adminDir ?? join(projectSiteDir, 'admin')
    const editorsDir = join(admDir, 'editors')
    const fieldsDir = join(admDir, 'fields')
    // In dev mode, Vite serves source files via /@fs/ URLs
    const fieldsBaseUrl = production ? '/admin/fields' : `/admin/@fs/${fieldsDir}`
    return { tplDir, editorsDir, fieldsBaseUrl }
  }

  app.openapi(listTemplates, async c => {
    const { tplDir } = await dirs(c.req.valid('query').target)
    if (!(await storage.exists(tplDir))) return c.json([], 200)

    const entries = await storage.readDir(tplDir)
    const templates = entries.filter(e => e.isDirectory).map(e => ({ name: e.name }))
    return c.json(templates, 200)
  })

  app.openapi(templateSchema, async c => {
    const { name } = c.req.valid('param')
    const { tplDir, editorsDir, fieldsBaseUrl } = await dirs(c.req.valid('query').target)

    try {
      const loaded = await loadTemplate(storage, tplDir, name)
      const jsonSchema = z.toJSONSchema(loaded.schema as z.ZodType)
      const hasEditor = await hasEditorFile(storage, editorsDir, name)

      let editorUrl: string | undefined
      if (hasEditor) {
        if (production) {
          // Production — pre-bundled JS
          editorUrl = `/admin/editors/${name}.js`
        } else {
          // Dev mode — Vite /@fs/ serving
          for (const ext of EDITOR_EXTENSIONS) {
            const filePath = join(editorsDir, `${name}${ext}`)
            if (await storage.exists(filePath)) {
              editorUrl = `/admin/@fs/${filePath}`
              break
            }
          }
        }
      }

      return c.json(
        {
          ...(jsonSchema as Record<string, unknown>),
          hasEditor,
          ...(editorUrl === undefined ? {} : { editorUrl }),
          fieldsBaseUrl,
        },
        200,
      )
    } catch (err) {
      return problem(c, 500, 'INTERNAL', `Failed to load schema for template "${name}": ${(err as Error).message}`)
    }
  })

  /**
   * GET /api/templates/:name/impact — Validation Cut 6.
   *
   * Returns the items (pages + fragments) that use this template, along
   * with their issues from the background scanner. Powers the
   * DevPlayground "Impact" tab + the toolbar banner's view-impact link.
   *
   * The walk recurses into nested inline components (a page that doesn't
   * top-level-use the template but contains a deep inline component
   * with that template still appears in the impact list — its
   * schema-conformance issues land on the item).
   *
   * `scanner` is optional. When validation is disabled (or not yet
   * built at boot), every item appears with `issues: []` — accurate
   * since no validation ran.
   */
  app.openapi(templateImpact, async c => {
    const { name } = c.req.valid('param')
    const source = await resolve(c.req.valid('query').target)
    let site: import('../../site-loader.js').Site
    try {
      site = await loadSiteFromSource(source)
    } catch (err) {
      return problem(c, 500, 'INTERNAL', `Failed to load site: ${(err as Error).message}`)
    }
    const issuesFor = (path: string) => opts.scanner?.issuesFor(path) ?? []
    const impact = computeTemplateImpact(site, name, issuesFor)
    // Copied: the response type's arrays are mutable.
    return c.json({ ...impact, items: impact.items.map(i => ({ ...i, issues: [...i.issues] })) }, 200)
  })

  return app
}
