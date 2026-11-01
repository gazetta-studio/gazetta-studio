/**
 * `deprecate()` (design-agent-access.md Q43): a deprecated route answers
 * with `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) and is marked
 * deprecated in the document; its handler doesn't change.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { deprecate, json } from '../src/admin-api/openapi.js'

const since = new Date('2026-11-01T00:00:00Z')
const sunset = new Date('2027-06-01T00:00:00Z')

const route = createRoute({
  method: 'get',
  path: '/old',
  responses: { 200: json(z.object({ ok: z.boolean() }), 'Still works') },
})

function appWithDeprecatedRoute() {
  const app = new OpenAPIHono()
  app.openapi(deprecate(route, { since, sunset }), c => c.json({ ok: true }, 200))
  app.openapi(createRoute({ ...route, path: '/current' }), c => c.json({ ok: true }, 200))
  return app
}

describe('deprecate()', () => {
  it('answers with Deprecation and Sunset, and the handler still runs', async () => {
    const res = await appWithDeprecatedRoute().request('/old')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('Deprecation')).toBe(`@${since.getTime() / 1000}`)
    expect(res.headers.get('Sunset')).toBe('Tue, 01 Jun 2027 00:00:00 GMT')
  })

  it('leaves other routes without the headers', async () => {
    const res = await appWithDeprecatedRoute().request('/current')
    expect(res.headers.get('Deprecation')).toBeNull()
    expect(res.headers.get('Sunset')).toBeNull()
  })

  it('marks the route deprecated in the document', () => {
    const doc = appWithDeprecatedRoute().getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } })
    expect(doc.paths?.['/old']?.get?.deprecated).toBe(true)
    expect(doc.paths?.['/current']?.get?.deprecated).toBeUndefined()
  })

  it('refuses a sunset less than six months after deprecation', () => {
    expect(() => deprecate(route, { since, sunset: new Date('2027-02-01T00:00:00Z') })).toThrow(/six months/)
  })
})
