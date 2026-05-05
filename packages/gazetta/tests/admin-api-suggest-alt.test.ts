/**
 * HTTP-level tests for `POST /api/assets/:name/suggest-alt`.
 *
 * Verifies the route adapter correctly translates orchestration
 * results (`SuggestAltResult` from `alt/route-handler.ts`) to HTTP
 * status codes + body shapes. Orchestration correctness is covered by
 * `alt-route-handler.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetRoutes } from '../src/admin-api/routes/assets.js'
import { staticSourceResolver, createSourceContext } from '../src/admin-api/source-context.js'
import { anthropicProvider } from '../src/alt/anthropic.js'
import { ollamaProvider } from '../src/alt/ollama.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { SiteManifest } from '../src/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('http-suggest-alt-test-' + Date.now())

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

async function jpegBytes(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

function buildApp(siteManifest?: SiteManifest) {
  const storage = createFilesystemProvider(testDir)
  const source = createSourceContext({
    storage,
    siteDir: '',
    manifest: siteManifest,
  })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.route('/', assetRoutes(resolve))
  return { app, storage }
}

async function seedAsset(storage: ReturnType<typeof createFilesystemProvider>, name = 'hero', hash = 'abc12345') {
  const bytes = await jpegBytes()
  const manifest = {
    version: 1,
    name,
    kind: 'embedded',
    source: 'internal',
    mime: 'image/jpeg',
    size: bytes.byteLength,
    hash,
    width: 200,
    height: 200,
    duration: null,
    alt: null,
    focalPoint: null,
    tags: [],
    variants: [],
    variantsStatus: 'complete',
    uploadedAt: '2026-05-03T00:00:00Z',
    uploadedBy: '',
  }
  await storage.writeFile(`assets/${name}.asset.json`, JSON.stringify(manifest))
  await storage.writeBytes(`assets/${name}-${hash}.jpg`, bytes)
}

describe('POST /api/assets/:name/suggest-alt — happy path', () => {
  it('200s with structured suggestion when adapter responds', async () => {
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const { app, storage } = buildApp(site)
    await seedAsset(storage)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: 'A black square.' },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.text).toBe('A black square.')
      expect(body.refused).toBe(false)
      expect(body.refusalReason).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns 200 with refused: true when model declines (NOT an error)', async () => {
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const { app, storage } = buildApp(site)
    await seedAsset(storage)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: "I can't describe this image." },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.refused).toBe(true)
      expect(body.refusalReason).not.toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('POST /api/assets/:name/suggest-alt — locale parameter', () => {
  it('forwards locale query to the adapter', async () => {
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const { app, storage } = buildApp(site)
    await seedAsset(storage)

    let captured: string | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        const body = JSON.parse(init?.body as string) as {
          messages: Array<{ role: string; content: string }>
        }
        captured = body.messages.find(m => m.role === 'system')?.content
        return new Response(JSON.stringify({ message: { role: 'assistant', content: 'description' }, done: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      const res = await app.request('/api/assets/hero/suggest-alt?locale=fr', { method: 'POST' })
      expect(res.status).toBe(200)
      // Composed prompt should mention the locale.
      expect(captured).toBeDefined()
      expect(captured).toContain('fr')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('400s on invalid locale code', async () => {
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const { app } = buildApp(site)
    const res = await app.request('/api/assets/hero/suggest-alt?locale=NOT_A_LOCALE!!!', { method: 'POST' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('BAD_REQUEST')
  })
})

describe('POST /api/assets/:name/suggest-alt — unavailable', () => {
  it('503s when no adapter is configured', async () => {
    // No `ai:` block at all.
    const site: SiteManifest = { name: 'test' }
    const { app, storage } = buildApp(site)
    await seedAsset(storage)
    const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('AI_ADAPTER_UNAVAILABLE')
  })

  it('503s when site manifest is unavailable on source', async () => {
    // No siteManifest passed to buildApp.
    const { app, storage } = buildApp()
    await seedAsset(storage)
    const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('AI_ADAPTER_UNAVAILABLE')
  })

  it('502s when the adapter is configured but the SDK call fails (no msw stub)', async () => {
    // Per Path X, the operator constructs the provider with a literal
    // apiKey at config-eval — there is no "credentials missing"
    // failure mode at the factory level. With a fake apiKey + no msw
    // stub, the real network call fails and the route surfaces 502.
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: anthropicProvider({ apiKey: 'sk-test', maxRetries: 0 }) },
      altText: { auto: true },
    }
    const { app, storage } = buildApp(site)
    await seedAsset(storage)
    const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
    // Could be 502 (transport failure reaches SDK) or 503 (some
    // environments treat unreachable hosts differently). The point is
    // the response is not 200.
    expect([502, 503]).toContain(res.status)
  })
})

describe('POST /api/assets/:name/suggest-alt — failed', () => {
  it('502s when the adapter call fails', async () => {
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const { app, storage } = buildApp(site)
    await seedAsset(storage)

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (): Promise<Response> => {
      // Network-level error.
      throw new TypeError('connection refused')
    }
    try {
      const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.code).toBe('AI_ADAPTER_FAILED')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('POST /api/assets/:name/suggest-alt — not found', () => {
  it('404s when asset does not exist on the target', async () => {
    const site: SiteManifest = {
      name: 'test',
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const { app } = buildApp(site)
    // No asset seeded.
    const res = await app.request('/api/assets/missing/suggest-alt', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MANIFEST_NOT_FOUND')
  })
})
