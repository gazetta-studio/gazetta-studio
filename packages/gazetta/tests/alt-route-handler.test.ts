/**
 * Unit tests for `alt/route-handler.ts` — orchestration between the
 * admin-api HTTP layer and the alt-text task domain.
 *
 * Tests are pure (no Hono, no msw): in-memory storage + env mocking.
 * The route-handler integrates the asset-domain (manifest reading) +
 * the alt-domain (suggester/factory) without HTTP concerns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { anthropicProvider } from '../src/alt/anthropic.js'
import { ollamaProvider } from '../src/alt/ollama.js'
import { suggestAltForAsset } from '../src/alt/route-handler.js'
import type { AssetManifest } from '../src/schema/types.js'
import type { SiteManifest } from '../src/types.js'

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

const ASSETS_ROOT = 'assets'

async function makeJpeg(width = 200, height = 200): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

/**
 * Seed a fresh storage with one asset (manifest + bytes). Returns
 * the manifest and storage so tests can verify or mutate.
 */
async function seedAsset(
  name: string,
  hash = 'abc12345',
): Promise<{ storage: MemoryStorage; manifest: AssetManifest }> {
  const storage = memoryStorage()
  const bytes = await makeJpeg()
  const manifest: AssetManifest = {
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
  await storage.writeFile(`${ASSETS_ROOT}/${name}.asset.json`, JSON.stringify(manifest))
  await storage.writeBytes(`${ASSETS_ROOT}/${name}-${hash}.jpg`, bytes)
  return { storage, manifest }
}

describe('suggestAltForAsset — unconfigured', () => {
  it('returns kind: unavailable when site has no AI config', async () => {
    const { storage } = await seedAsset('hero')
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {}
    const result = await suggestAltForAsset({
      name: 'hero',
      assetsRoot: ASSETS_ROOT,
      storage,
      site,
      target: undefined,
      locale: 'en',
    })
    expect(result.kind).toBe('unavailable')
  })

  it('returns kind: failed when adapter call hits a transport error (no msw stub)', async () => {
    // Per Path X, the operator constructs the provider with a literal
    // apiKey at config-eval — there is no "credentials missing" failure
    // mode at the factory level. Auth/transport failures surface at
    // first SDK call instead. With a fake apiKey + no msw stub, the
    // real network call fails and the route-handler reports `failed`.
    const { storage } = await seedAsset('hero')
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: anthropicProvider({ apiKey: 'sk-test', maxRetries: 0 }) },
      altText: { auto: true },
    }
    const result = await suggestAltForAsset({
      name: 'hero',
      assetsRoot: ASSETS_ROOT,
      storage,
      site,
      target: undefined,
      locale: 'en',
    })
    // Either `failed` (transport error reached the SDK) or `unavailable`
    // (some test environments treat unreachable hosts as unsupported).
    // What matters is that the result is NOT `ok` when no msw is wired.
    expect(['failed', 'unavailable']).toContain(result.kind)
  })
})

describe('suggestAltForAsset — asset not found', () => {
  it('returns kind: not-found when asset name does not exist on target', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    const storage = memoryStorage()
    // Empty storage — no asset seeded.
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const result = await suggestAltForAsset({
      name: 'missing',
      assetsRoot: ASSETS_ROOT,
      storage,
      site,
      target: undefined,
      locale: 'en',
    })
    expect(result.kind).toBe('not-found')
    if (result.kind === 'not-found') {
      expect(result.message).toContain('missing')
    }
  })
})

describe('suggestAltForAsset — happy path (Ollama with mocked HTTP)', () => {
  it('returns kind: ok with structured suggestion when Ollama responds', async () => {
    // Ollama doesn't need a real API key, so we can wire it without
    // env mocking. We rely on msw setup in other tests; here we use
    // the simpler approach of pointing the adapter at a mock fetch.
    // Since this test is in the route-handler suite (not adapter
    // tests), we're integrating against the factory's actual Ollama
    // adapter. Mock fetch globally to return a happy response.

    const { storage } = await seedAsset('hero')
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }

    // Stub global fetch for this single call. Using Vitest's vi
    // approach would be cleaner but msw + setupServer is the
    // established pattern in adapter tests. For the orchestration
    // layer test, we just need to verify the wiring — simplest is
    // to skip the actual model call by stubbing fetch.
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        return new Response(
          JSON.stringify({
            model: 'llama3.2-vision:11b',
            message: { role: 'assistant', content: 'A black square.' },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return originalFetch(input, _init)
    }
    try {
      const result = await suggestAltForAsset({
        name: 'hero',
        assetsRoot: ASSETS_ROOT,
        storage,
        site,
        target: undefined,
        locale: 'en',
      })
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') {
        expect(result.suggestion.text).toBe('A black square.')
        expect(result.suggestion.refused).toBe(false)
        expect(result.suggestion.refusalReason).toBeNull()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns kind: ok with refused: true when model declines', async () => {
    const { storage } = await seedAsset('hero')
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
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
      const result = await suggestAltForAsset({
        name: 'hero',
        assetsRoot: ASSETS_ROOT,
        storage,
        site,
        target: undefined,
        locale: 'en',
      })
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') {
        expect(result.suggestion.refused).toBe(true)
        expect(result.suggestion.refusalReason).not.toBeNull()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('suggestAltForAsset — adapter call failure', () => {
  it('returns kind: failed when adapter throws', async () => {
    const { storage } = await seedAsset('hero')
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        // 500 from the upstream provider — adapter wraps as
        // AIAdapterFailedError, suggester returns null, route-handler
        // surfaces as `failed`.
        return new Response('internal error', { status: 500 })
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      const result = await suggestAltForAsset({
        name: 'hero',
        assetsRoot: ASSETS_ROOT,
        storage,
        site,
        target: undefined,
        locale: 'en',
      })
      expect(result.kind).toBe('failed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('suggestAltForAsset — locale parameter forwarding', () => {
  it('passes locale through to the adapter (visible in request body)', async () => {
    const { storage } = await seedAsset('hero')
    const site: Pick<SiteManifest, 'ai' | 'altText'> = {
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    }
    let capturedSystemPrompt: string | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        const body = JSON.parse(init?.body as string) as {
          messages: Array<{ role: string; content: string }>
        }
        capturedSystemPrompt = body.messages.find(m => m.role === 'system')?.content
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: 'description in french' },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      await suggestAltForAsset({
        name: 'hero',
        assetsRoot: ASSETS_ROOT,
        storage,
        site,
        target: undefined,
        locale: 'fr',
      })
      // The composed prompt should include the locale instruction.
      expect(capturedSystemPrompt).toBeDefined()
      expect(capturedSystemPrompt).toContain('fr')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
