/**
 * Capability-gate coverage for `GET /api/validation/issues`.
 *
 * Per design-auth-rbac.md every admin-API read route gates on a
 * capability via `requireCapability(...)`. The validation-issues
 * route was missing the gate at first ship — any caller (anonymous
 * or authenticated) received the full issue set. This test pins the
 * `read:pages` gate (matching the precedent set by `/api/pages`,
 * `/api/compare`, and `/api/dependents`):
 *
 *   - anonymous principal → 401 with `WWW-Authenticate`
 *   - authenticated principal without `read:pages` → 403 with
 *     structured body
 *   - authenticated principal with `read:pages` (or `read:*` / `*`) → 200
 *
 * Per design-validation.md "Foundational checks (Team check)":
 *     an editor without page X read access doesn't see issues for page X
 *
 * v1 enforces this at the coarse-grained route level (a viewer with
 * `read:*` sees the full listing; per-page filtering is a future
 * `read:pages:{pattern}` capability). The gate must, at minimum, refuse
 * anonymous and editor-without-read access — that's what this test pins.
 *
 * Strategy mirrors `audit-route.test.ts`: mount the real route factory
 * under a Hono app with `principalMiddleware` driven by either
 * `noneAuthProvider` (admin/`*` principal) or a synthetic provider
 * returning a principal with explicit capabilities.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { validationRoutes } from '../src/admin-api/routes/validation.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { noneAuthProvider } from '../src/auth/providers/none.js'
import type { AuthIdentityProvider, Principal } from '../src/auth/index.js'
import type { ValidationScanner } from '../src/validation/scanner.js'
import type { Issue } from '../src/validation/types.js'

function makeIssue(partial: Partial<Issue> = {}): Issue {
  return {
    validator: 'referenced-asset-exists',
    severity: 'error',
    message: 'asset "hero" missing',
    itemPath: 'pages/home/page.json',
    ...partial,
  }
}

function makeScanner(issues: readonly Issue[] = []): ValidationScanner {
  return {
    async scanAll() {},
    async rescan() {},
    allIssues: () => issues,
    issuesFor: () => [],
    subscribe: () => () => {},
  }
}

function buildAppWithRole(
  scanner: ValidationScanner | null,
  role: string,
  capabilities: ReadonlyArray<string>,
): Hono {
  const provider: AuthIdentityProvider = {
    trustMode: 'forwarded-user',
    async extractPrincipal(): Promise<Principal> {
      return {
        id: role === 'unknown' ? 'unknown' : `${role}@example.com`,
        role,
        trustMode: 'forwarded-user',
        capabilities,
      }
    },
  }
  const app = new Hono()
  app.use('/api/*', principalMiddleware(provider))
  app.route('/', validationRoutes({ scanner }))
  return app
}

function buildAnonymousApp(scanner: ValidationScanner | null): Hono {
  // Provider that returns null → principalMiddleware synthesizes the
  // anonymous principal (id 'unknown', role 'unknown', capabilities []).
  const provider: AuthIdentityProvider = {
    trustMode: 'forwarded-user',
    async extractPrincipal(): Promise<Principal | null> {
      return null
    },
  }
  const app = new Hono()
  app.use('/api/*', principalMiddleware(provider))
  app.route('/', validationRoutes({ scanner }))
  return app
}

function buildDefaultApp(scanner: ValidationScanner | null): Hono {
  // noneAuthProvider yields the admin/'*' principal — matches
  // createAdminApp's default when no auth is configured.
  const app = new Hono()
  app.use('/api/*', principalMiddleware(noneAuthProvider))
  app.route('/', validationRoutes({ scanner }))
  return app
}

describe('GET /api/validation/issues — capability gate', () => {
  it('admin role with `*` is allowed (200) and returns the issue set', async () => {
    const issues = [makeIssue()]
    const app = buildDefaultApp(makeScanner(issues))
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issues: Issue[]; total: number }
    expect(body.total).toBe(1)
    expect(body.issues).toHaveLength(1)
    expect(body.issues[0].itemPath).toBe('pages/home/page.json')
  })

  it('editor role with `read:*` is allowed (200)', async () => {
    const app = buildAppWithRole(makeScanner([makeIssue()]), 'editor', ['read:*', 'edit:*'])
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(200)
  })

  it('viewer role with `read:pages` exactly is allowed (200)', async () => {
    const app = buildAppWithRole(makeScanner([]), 'viewer', ['read:pages'])
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(200)
  })

  it('authenticated principal without read:pages is forbidden (403) with structured body', async () => {
    // Custom role that grants edit on assets but not read on pages.
    // Models a hypothetical asset-only translator role.
    const app = buildAppWithRole(makeScanner([makeIssue()]), 'asset-editor', ['edit:assets'])
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['read:pages'])
    expect(body.role).toBe('asset-editor')
  })

  it('anonymous principal (no upstream auth) is rejected with 401 + WWW-Authenticate', async () => {
    const app = buildAnonymousApp(makeScanner([makeIssue()]))
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('UNAUTHENTICATED')
  })

  it('refuses anonymous access even when no scanner is configured', async () => {
    // Belt-and-suspenders: the scanner being null doesn't relax the
    // gate. Anonymous + no scanner still produces 401, not a successful
    // empty list. (Pre-fix, anonymous + null scanner returned 200 with
    // `{ issues: [], total: 0 }` — that's the regression to prevent.)
    const app = buildAnonymousApp(null)
    const res = await app.request('/api/validation/issues')
    expect(res.status).toBe(401)
  })
})
