import { describe, expect, it } from 'vitest'
import { devRoute } from '../src/cli/dev-routing.js'

describe('devRoute (#1716)', () => {
  it.each([
    ['/admin/api/health', 'hono', 'hono'],
    ['/admin/api/v1/auth/logins', 'hono', 'hono'],
    ['/admin/preview/home', 'hono', 'hono'],
    ['/admin/theme.css?v=1', 'hono', 'hono'],
    ['/admin/ping', 'ping', 'ping'],
    ['/admin', 'loader', 'vite'],
    ['/admin?x=1', 'loader', 'vite'],
    ['/adminx', 'hono', 'hono'],
    ['/admin/pages/home', 'loader', 'vite'],
    ['/@vite/client', 'loader', 'vite'],
    ['/', 'hono', 'hono'],
    ['/about', 'hono', 'hono'],
  ])('%s: %s while Vite starts, %s once ready', (url, starting, ready) => {
    expect(devRoute(url, false)).toBe(starting)
    expect(devRoute(url, true)).toBe(ready)
  })
})
