/**
 * The problem+json helper (`admin-api/problem.ts`, design-agent-access.md
 * Q45) and the admin app's catch-all and error handler.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { PROBLEM_CONTENT_TYPE, problem, problemBody, problemFrom } from '../src/admin-api/problem.js'
import { ErrorResponseSchema } from '../src/admin-api/schemas/error.js'

async function call(handler: Parameters<Hono['get']>[1]) {
  const app = new Hono()
  app.get('/x', handler)
  return app.request('/x')
}

describe('problem()', () => {
  it('answers application/problem+json with the RFC 9457 members and the code', async () => {
    const res = await call(c => problem(c, 409, 'STALE', 'Was edited by someone else', { currentEtag: 'e1' }))
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE)
    const body = ErrorResponseSchema.parse(await res.json())
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Was edited by someone else',
      code: 'STALE',
      currentEtag: 'e1',
    })
  })

  it('leaves detail out when there is none', () => {
    expect(problemBody(404, 'NOT_FOUND')).not.toHaveProperty('detail')
  })

  it('does not let extras override the standard members or the code', () => {
    const body = problemBody(400, 'BAD_REQUEST', 'x', { status: 200, code: 'STALE', type: 'x', title: 'y' })
    expect(body).toMatchObject({ type: 'about:blank', title: 'Bad Request', status: 400, code: 'BAD_REQUEST' })
  })
})

describe('problemFrom()', () => {
  it("turns an error class's { code, message, ...extras } into a problem", async () => {
    const res = await call(c =>
      problemFrom(c, 409, { code: 'ASSET_IN_USE', message: 'In use', assetName: 'hero', refs: [] } as {
        code: string
        message: string
      }),
    )
    const body = ErrorResponseSchema.parse(await res.json())
    expect(body).toMatchObject({ status: 409, code: 'ASSET_IN_USE', detail: 'In use', assetName: 'hero', refs: [] })
    expect(body).not.toHaveProperty('message')
  })
})
