/**
 * Mutation-coverage tests for `admin-api/routes/assets.ts` — closes
 * surviving / no-coverage mutants identified by the StrykerJS run
 * (issue #310). Coverage gaps targeted:
 *
 *  - `ConditionalExpression` (`→ true` / `→ false`) and `EqualityOperator`
 *    (`theme === undefined` → `theme !== undefined`) on line 59's guard
 *    `if (locale === undefined && theme === undefined) return null`.
 *    Existing tests assert status codes on the locale-bytes routes but
 *    never distinguish the "guard returned null" 400 (from the route
 *    caller's `=== null` branch) from "ingestion proceeded but failed"
 *    paths. Pinning the exact error-message body distinguishes the two.
 *
 *  - `ObjectLiteral` (`→ {}`) and `StringLiteral` (`→ ""`, `→ \`\``)
 *    on lines 61 / 63 (invalid-locale 400 body) and lines 67 / 69
 *    (invalid-theme 400 body). Existing tests assert `status === 400`
 *    but don't inspect `code`, `message`, or the `content-type` header,
 *    so replacing the body literal with `{}` or `""` doesn't fail any
 *    assertion. These tests pin the exact body shape on both POST and
 *    DELETE.
 *
 *  - Path-through to ingestion / removal when only one dimension is set
 *    (`?locale=fr` alone, `?theme=dark` alone). The EqualityOperator
 *    mutation flips the guard's semantics so theme-only requests return
 *    null instead of proceeding; only a "theme-only succeeds" test kills
 *    that mutant. Both POST (expect 201) and DELETE (expect 404 because
 *    no override exists yet) prove the route progressed past the guard.
 *
 *  - `selectorSuffix` composition for the compound `?locale=fr&theme=dark`
 *    case — the resulting bytesPath must include both dimension values.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh tempDir
 * + a fresh filesystem provider + a fresh Hono app. No module-level
 * state. Per testing-plan.md "Storage tier": fs is required here
 * because POST exercises sharp variant generation against real bytes.
 *
 * VERIFICATION NOTES (manual mutation walk against this file):
 *
 *   - `if (false) return null` on line 59:
 *       no-selector POST → ingestion runs with empty `Selector` → writes
 *       to default manifest path → 201 OR 409 depending on collision.
 *       NOT 400 with `'Selector required (locale and/or theme)'` body.
 *       Killed by "no-selector POST returns 400 with the exact route
 *       caller's body".
 *   - `if (true) return null` on line 59:
 *       valid locale POST → null → route returns "Selector required"
 *       400 instead of 201. Killed by "valid locale POST returns 201".
 *   - `theme !== undefined` on line 59 EqualityOperator:
 *       theme-only POST → null → "Selector required" 400 instead of
 *       201. Killed by "theme-only POST returns 201".
 *   - `→ {}` on line 61 / 63 (invalid-locale body / headers):
 *       invalid locale POST → empty body / empty headers. Killed by
 *       "invalid-locale body has code='BAD_REQUEST', message contains
 *       'Invalid locale', content-type is application/json".
 *   - `→ ""` / `→ \`\`` on line 61 (invalid-locale message string):
 *       message would be empty. Killed by message substring assertion.
 *   - Equivalent mutations on lines 67 / 69 (invalid-theme body):
 *       same shape, killed by the theme-variant of the assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetRoutes } from '../src/admin-api/routes/assets.js'
import { staticSourceResolver, createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('http-assets-mutation-coverage-' + Date.now())

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function buildApp() {
  const storage = createFilesystemProvider(testDir)
  const source = createSourceContext({ storage, siteDir: '' })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.use('/api/*', principalMiddleware())
  app.route('/', assetRoutes(resolve))
  return { app, storage }
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
}

function multipartForm(fields: Record<string, string | { name: string; bytes: Uint8Array; type: string }>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      form.set(key, value)
    } else {
      form.set(key, new File([value.bytes], value.name, { type: value.type }))
    }
  }
  return form
}

async function uploadHero(app: Hono) {
  const bytes = await jpegBuffer()
  await app.request('/api/assets', {
    method: 'POST',
    body: multipartForm({
      file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
      name: 'hero',
    }),
  })
}

async function uploadFrenchOverride(app: Hono) {
  const bytes = await jpegBuffer()
  return app.request('/api/assets/hero/locale-bytes?locale=fr', {
    method: 'POST',
    body: multipartForm({ file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' } }),
  })
}

describe('selectorFromQuery — POST /api/assets/:name/locale-bytes', () => {
  describe('invalid-selector 400 body shape', () => {
    it('invalid locale 400 has code=BAD_REQUEST, message naming the bad locale, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      // Header pins line-63 `headers: { 'content-type': 'application/json' }`.
      // The raw `Response` from selectorFromQuery sets `content-type`
      // explicitly; ObjectLiteral → {} would drop the header (Hono lets
      // a custom-Response pass through unchanged).
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      // Pins line-61 body literal.
      expect(body.code).toBe('BAD_REQUEST')
      expect(typeof body.message).toBe('string')
      expect(body.message.length).toBeGreaterThan(0)
      expect(body.message).toContain('Invalid locale')
      // The locale value gets interpolated into the message (template literal).
      // StringLiteral → `` would drop the prefix; this anchors the substring.
      expect(body.message).toContain('NOT-A-LOCALE-FORMAT')
    })

    it('invalid theme 400 has code=BAD_REQUEST, message naming the bad theme, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=NOT-A-VALID-THEME', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message.length).toBeGreaterThan(0)
      expect(body.message).toContain('Invalid theme')
      expect(body.message).toContain('NOT-A-VALID-THEME')
    })

    it('invalid locale takes precedence over a present (valid) theme', async () => {
      // Order matters in the function: locale is checked first. A
      // mutation that flipped the check ordering would produce the
      // theme-error message; this test pins the locale error.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT&theme=dark', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toContain('Invalid locale')
    })
  })

  describe('guard returns null vs proceeds — distinguished by error-body shape', () => {
    it('no selector at all 400s with the route caller\'s "Selector required" body (proves guard returned null)', async () => {
      // Under `if (false) return null`, the guard NEVER returns null;
      // selectorFromQuery falls through to `return buildSelector({})`,
      // which is a non-null Selector. The route's `=== null` branch
      // doesn't fire, so the "Selector required" body never appears
      // (ingestion runs against the empty selector instead).
      //
      // Under the original code, the guard returns null and the
      // route's `=== null` branch fires with the exact body asserted
      // here.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toBe('Selector required (locale and/or theme)')
    })
  })

  describe('valid selector — route proceeds past the guard', () => {
    it('valid locale only (no theme) 201s with bytesPath suffix .fr.jpg (kills "guard always returns null")', async () => {
      // Under `if (true) return null`, selectorFromQuery returns null
      // for every input; the route returns 400 "Selector required"
      // for valid locales. This test asserts 201, killing the mutation.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as { manifest: { name: string }; bytesPath: string }
      expect(body.manifest.name).toBe('hero')
      // selectorSuffix({locale: 'fr'}) → '.fr' → 'hero-{hash}.fr.jpg'
      expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.fr\.jpg$/)
    })

    it('valid theme only (no locale) 201s with bytesPath suffix .dark.jpg (kills EqualityOperator on guard)', async () => {
      // Under `theme === undefined` → `theme !== undefined`, the guard
      // becomes `if (locale === undefined && theme !== undefined) return null`.
      // A theme-only request matches both conjuncts → returns null →
      // route returns 400 "Selector required" instead of 201. This
      // test asserts 201, killing that mutant.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=dark', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as { manifest: { name: string }; bytesPath: string }
      expect(body.manifest.name).toBe('hero')
      // selectorSuffix({theme: 'dark'}) → '.dark' → 'hero-{hash}.dark.jpg'
      expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.dark\.jpg$/)
    })

    it('compound locale+theme 201s with bytesPath suffix .fr.dark.jpg (pins selectorSuffix composition)', async () => {
      // Locked filename composition: locale before theme. Pins both
      // dimensions appear in the persisted bytes path; a mutation
      // that dropped one dimension from `buildSelector({...spread})`
      // would surface here as a missing path segment.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr&theme=dark', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as { manifest: { name: string }; bytesPath: string }
      expect(body.manifest.name).toBe('hero')
      expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.fr\.dark\.jpg$/)
    })
  })
})

describe('selectorFromQuery — DELETE /api/assets/:name/locale-bytes', () => {
  describe('invalid-selector 400 body shape', () => {
    it('invalid locale 400 has code=BAD_REQUEST, message naming the bad locale, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT', {
        method: 'DELETE',
      })

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toContain('Invalid locale')
      expect(body.message).toContain('NOT-A-LOCALE-FORMAT')
    })

    it('invalid theme 400 has code=BAD_REQUEST, message naming the bad theme, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=NOT-A-VALID-THEME', {
        method: 'DELETE',
      })

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toContain('Invalid theme')
      expect(body.message).toContain('NOT-A-VALID-THEME')
    })
  })

  describe('guard returns null vs proceeds — distinguished by error-body shape', () => {
    it('no selector 400s with the route caller\'s "Selector required" body (proves guard returned null)', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes', { method: 'DELETE' })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toBe('Selector required (locale and/or theme)')
    })
  })

  describe('valid selector — route proceeds past the guard', () => {
    it('valid locale only (no existing override) 404s — proves route reached removeOverride past the guard', async () => {
      // Under `if (true) return null`, the route would return 400
      // "Selector required" for every input. This test asserts 404
      // (the override doesn't exist), which only fires when the
      // selector check passed and removeOverride was called.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })

      expect(res.status).toBe(404)
    })

    it('valid theme only (no existing override) 404s — kills EqualityOperator on guard via DELETE path', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=dark', { method: 'DELETE' })

      expect(res.status).toBe(404)
    })

    it('valid locale 204s after the override exists — full happy-path proves the selector reaches removeOverride correctly', async () => {
      // Already covered by admin-api-assets.test.ts but pinned here
      // alongside the rest of the matrix so a future refactor that
      // splits selectorFromQuery semantics between POST and DELETE
      // surfaces immediately.
      const { app } = buildApp()
      await uploadHero(app)
      await uploadFrenchOverride(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })
      expect(res.status).toBe(204)
    })
  })
})
