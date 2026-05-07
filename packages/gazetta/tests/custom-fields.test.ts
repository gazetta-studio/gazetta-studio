import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { Hono } from 'hono'
import { format } from '../src/formats.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { tempDir } from './_helpers/temp.js'

/**
 * Wrap a route module's Hono app with the principal middleware so
 * the capability gates on /api/* routes are populated. createAdminApp
 * does this in production; tests that wire routes directly need to
 * mirror it.
 */
function withAuth(routesApp: Hono): Hono {
  const wrapped = new Hono()
  wrapped.use('/api/*', principalMiddleware())
  wrapped.route('/', routesApp)
  return wrapped
}

describe('format.field()', () => {
  it('returns meta object with field name', () => {
    expect(format.field('brand-color')).toEqual({ field: 'brand-color' })
  })

  it('field property flows through to JSON Schema', () => {
    const schema = z.object({
      color: z.string().meta(format.field('brand-color')).describe('Brand color'),
      title: z.string().describe('Title'),
    })
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.color.field).toBe('brand-color')
    expect(properties.title.field).toBeUndefined()
  })

  it('field and format can coexist on same property', () => {
    const schema = z.object({
      color: z.string().meta({ field: 'brand-color', format: 'color' }).describe('Color'),
    })
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.color.field).toBe('brand-color')
    expect(properties.color.format).toBe('color')
  })
})

describe('fields API', () => {
  const testDir = tempDir('fields-api-' + Date.now())

  beforeEach(async () => {
    await mkdir(join(testDir, 'admin', 'fields'), { recursive: true })
    await mkdir(join(testDir, 'templates'), { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('lists .ts and .tsx field files', async () => {
    await writeFile(join(testDir, 'admin', 'fields', 'brand-color.tsx'), 'export default {}')
    await writeFile(join(testDir, 'admin', 'fields', 'rating.ts'), 'export default {}')

    const { fieldRoutes } = await import('../src/admin-api/routes/fields.js')
    const storage = createFilesystemProvider()
    const { createSourceContext, staticSourceResolver } = await import('../src/admin-api/source-context.js')
    const app = withAuth(fieldRoutes(staticSourceResolver(createSourceContext({ storage, siteDir: testDir }))))
    const res = await app.request('/api/fields')
    expect(res.status).toBe(200)
    const fields = (await res.json()) as { name: string; path: string }[]
    expect(fields).toHaveLength(2)
    expect(fields.map(f => f.name).sort()).toEqual(['brand-color', 'rating'])
  })

  it('returns empty array when no fields directory', async () => {
    await rm(join(testDir, 'admin', 'fields'), { recursive: true, force: true })

    const { fieldRoutes } = await import('../src/admin-api/routes/fields.js')
    const storage = createFilesystemProvider()
    const { createSourceContext, staticSourceResolver } = await import('../src/admin-api/source-context.js')
    const app = withAuth(fieldRoutes(staticSourceResolver(createSourceContext({ storage, siteDir: testDir }))))
    const res = await app.request('/api/fields')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('ignores non-ts files', async () => {
    await writeFile(join(testDir, 'admin', 'fields', 'brand-color.tsx'), 'export default {}')
    await writeFile(join(testDir, 'admin', 'fields', 'README.md'), '# Fields')
    await writeFile(join(testDir, 'admin', 'fields', 'utils.js'), 'export const x = 1')

    const { fieldRoutes } = await import('../src/admin-api/routes/fields.js')
    const storage = createFilesystemProvider()
    const { createSourceContext, staticSourceResolver } = await import('../src/admin-api/source-context.js')
    const app = withAuth(fieldRoutes(staticSourceResolver(createSourceContext({ storage, siteDir: testDir }))))
    const res = await app.request('/api/fields')
    const fields = (await res.json()) as { name: string }[]
    expect(fields).toHaveLength(1)
    expect(fields[0].name).toBe('brand-color')
  })
})

describe('templates API includes fieldsBaseUrl', () => {
  it('schema response includes fieldsBaseUrl', async () => {
    const projectRoot = join(import.meta.dirname, '../../../examples/starter')
    const siteDir = join(projectRoot, 'sites/main')
    const storage = createFilesystemProvider()

    const { templateRoutes } = await import('../src/admin-api/routes/templates.js')
    const { createSourceContext, staticSourceResolver } = await import('../src/admin-api/source-context.js')
    const source = createSourceContext({ storage, siteDir })
    const app = withAuth(
      templateRoutes(staticSourceResolver(source), join(projectRoot, 'templates'), join(projectRoot, 'admin')),
    )

    const res = await app.request('/api/templates/hero/schema')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.fieldsBaseUrl).toBeDefined()
    expect(typeof body.fieldsBaseUrl).toBe('string')
    expect(body.fieldsBaseUrl).toContain('/admin/@fs/')
    expect(body.fieldsBaseUrl).toContain('admin/fields')
  })

  it('banner template schema has field property for background', async () => {
    const projectRoot = join(import.meta.dirname, '../../../examples/starter')
    const siteDir = join(projectRoot, 'sites/main')
    const storage = createFilesystemProvider()

    const { templateRoutes } = await import('../src/admin-api/routes/templates.js')
    const { createSourceContext, staticSourceResolver } = await import('../src/admin-api/source-context.js')
    const source = createSourceContext({ storage, siteDir })
    const app = withAuth(
      templateRoutes(staticSourceResolver(source), join(projectRoot, 'templates'), join(projectRoot, 'admin')),
    )

    const res = await app.request('/api/templates/banner/schema')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const properties = body.properties as Record<string, Record<string, unknown>>
    expect(properties.background.field).toBe('brand-color')
  })
})
