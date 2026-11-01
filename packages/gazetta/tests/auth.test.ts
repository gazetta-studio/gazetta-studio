import { describe, it, expect, afterEach } from 'vitest'
import { ErrorResponseSchema } from '../src/admin-api/schemas/error.js'
import { Hono } from 'hono'
import { authMiddleware } from '../src/admin-api/middleware/auth.js'

describe('authMiddleware', () => {
  const originalEnv = process.env.GAZETTA_TOKEN

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GAZETTA_TOKEN = originalEnv
    } else {
      delete process.env.GAZETTA_TOKEN
    }
  })

  it('passes through when no token configured', async () => {
    delete process.env.GAZETTA_TOKEN
    const app = new Hono()
    app.use('/api/*', authMiddleware())
    app.get('/api/v1/test', c => c.json({ ok: true }))

    const res = await app.request('/api/v1/test')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects requests without Authorization header', async () => {
    process.env.GAZETTA_TOKEN = 'secret123'
    const app = new Hono()
    app.use('/api/*', authMiddleware())
    app.get('/api/v1/test', c => c.json({ ok: true }))

    const res = await app.request('/api/v1/test')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    const body = ErrorResponseSchema.parse(await res.json())
    expect(body.code).toBe('UNAUTHENTICATED')
    expect(body.detail).toBe('Unauthorized')
  })

  it('rejects requests with wrong token', async () => {
    process.env.GAZETTA_TOKEN = 'secret123'
    const app = new Hono()
    app.use('/api/*', authMiddleware())
    app.get('/api/v1/test', c => c.json({ ok: true }))

    const res = await app.request('/api/v1/test', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts requests with correct token', async () => {
    process.env.GAZETTA_TOKEN = 'secret123'
    const app = new Hono()
    app.use('/api/*', authMiddleware())
    app.get('/api/v1/test', c => c.json({ ok: true }))

    const res = await app.request('/api/v1/test', {
      headers: { Authorization: 'Bearer secret123' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('does not affect non-api routes', async () => {
    process.env.GAZETTA_TOKEN = 'secret123'
    const app = new Hono()
    app.use('/api/*', authMiddleware())
    app.get('/public', c => c.json({ ok: true }))

    const res = await app.request('/public')
    expect(res.status).toBe(200)
  })
})
