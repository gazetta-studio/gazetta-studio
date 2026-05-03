/**
 * Unit tests for `alt/ollama.ts` — third provider adapter; the
 * self-hosted path. No SDK; raw fetch against a local-by-default URL.
 *
 * Same test shape as Anthropic and OpenAI adapters. msw intercepts
 * `http://localhost:11434/api/chat`. No real Ollama instance needed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { AIAdapterFailedError, AIInvalidResponseError } from '../src/ai/errors.js'
import { type AltGenerateInput, DEFAULT_ALT_REQUEST } from '../src/alt/adapter.js'
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, createOllamaAltAdapter } from '../src/alt/ollama.js'

const API_URL = `${OLLAMA_DEFAULT_BASE_URL}/api/chat`

interface CapturedRequest {
  body: {
    model: string
    stream: boolean
    messages: Array<{
      role: string
      content: string
      images?: string[]
    }>
  }
}

let captured: CapturedRequest[] = []

const server = setupServer()

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  captured = []
})
afterAll(() => server.close())

function mockResponse(text: string, status = 200): void {
  server.use(
    http.post(API_URL, async ({ request }) => {
      captured.push({ body: (await request.json()) as CapturedRequest['body'] })
      if (status !== 200) {
        return HttpResponse.text(text, { status })
      }
      return HttpResponse.json({
        model: 'llama3.2-vision:11b',
        message: { role: 'assistant', content: text },
        done: true,
        total_duration: 1_000_000,
      })
    }),
  )
}

function mockNetworkError(): void {
  server.use(http.post(API_URL, () => HttpResponse.error()))
}

function makeInput(overrides: Partial<AltGenerateInput> = {}): AltGenerateInput {
  return {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    mime: 'image/jpeg',
    request: { ...DEFAULT_ALT_REQUEST },
    prompt: 'You are writing alt text.',
    ...overrides,
  }
}

describe('createOllamaAltAdapter — basic', () => {
  it('exposes name "ollama"', () => {
    const adapter = createOllamaAltAdapter()
    expect(adapter.name).toBe('ollama')
  })

  it('supports JPEG and PNG only (post-prep MIMEs)', () => {
    const adapter = createOllamaAltAdapter()
    expect(adapter.supports('image/jpeg')).toBe(true)
    expect(adapter.supports('image/png')).toBe(true)
  })

  it('rejects non-prepped image formats', () => {
    const adapter = createOllamaAltAdapter()
    // After prepareForVision, GIF/WebP are converted to JPEG/PNG.
    // Adapter only accepts the post-prep MIMEs; defending the suggester contract.
    expect(adapter.supports('image/gif')).toBe(false)
    expect(adapter.supports('image/webp')).toBe(false)
    expect(adapter.supports('image/svg+xml')).toBe(false)
    expect(adapter.supports('audio/mpeg')).toBe(false)
  })
})

describe('createOllamaAltAdapter — happy path', () => {
  it('returns the model output verbatim', async () => {
    mockResponse('Mountain at sunset')
    const adapter = createOllamaAltAdapter()
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('Mountain at sunset')
    expect(result.refused).toBe(false)
    expect(result.refusalReason).toBeNull()
  })

  it('trims whitespace from output', async () => {
    mockResponse('  Trees in autumn.\n  ')
    const adapter = createOllamaAltAdapter()
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('Trees in autumn.')
  })

  it('uses configured model', async () => {
    mockResponse('ok')
    const adapter = createOllamaAltAdapter({ model: 'llama3.2-vision:90b' })
    await adapter.generate(makeInput())
    expect(captured[0].body.model).toBe('llama3.2-vision:90b')
  })

  it('defaults to llama3.2-vision:11b', async () => {
    mockResponse('ok')
    const adapter = createOllamaAltAdapter()
    await adapter.generate(makeInput())
    expect(captured[0].body.model).toBe(OLLAMA_DEFAULT_MODEL)
  })

  it('disables streaming for single-shot response', async () => {
    mockResponse('ok')
    const adapter = createOllamaAltAdapter()
    await adapter.generate(makeInput())
    expect(captured[0].body.stream).toBe(false)
  })

  it('puts the composed prompt in a system message', async () => {
    mockResponse('ok')
    const adapter = createOllamaAltAdapter()
    await adapter.generate(makeInput({ prompt: 'Custom system prompt.' }))
    const sys = captured[0].body.messages.find(m => m.role === 'system')
    expect(sys).toBeDefined()
    expect(sys?.content).toBe('Custom system prompt.')
  })

  it('puts the image in the user message images[] array (base64)', async () => {
    mockResponse('ok')
    const adapter = createOllamaAltAdapter()
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    await adapter.generate(makeInput({ bytes }))
    const userMsg = captured[0].body.messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg?.images).toBeDefined()
    expect(userMsg?.images?.[0]).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('strips trailing slashes from baseUrl', async () => {
    mockResponse('ok')
    const adapter = createOllamaAltAdapter({ baseUrl: 'http://localhost:11434/' })
    // Should still hit the same URL — no double slash.
    await adapter.generate(makeInput())
    expect(captured.length).toBe(1)
  })
})

describe('createOllamaAltAdapter — refusal', () => {
  it('detects shared refusal markers', async () => {
    mockResponse("I can't describe this image.")
    const adapter = createOllamaAltAdapter()
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(true)
  })

  it('detects Ollama-specific refusal phrases', async () => {
    mockResponse("I'm not able to process this image due to its content.")
    const adapter = createOllamaAltAdapter()
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(true)
  })

  it('passes through normal descriptions as not-refused', async () => {
    mockResponse('A cat sitting on a windowsill in the morning sun.')
    const adapter = createOllamaAltAdapter()
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(false)
  })
})

describe('createOllamaAltAdapter — errors', () => {
  it('translates 404 (model not pulled) to AIAdapterFailedError', async () => {
    mockResponse('model "llama3.2-vision:11b" not found, try `ollama pull`', 404)
    const adapter = createOllamaAltAdapter()
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('includes the status code in the error message', async () => {
    mockResponse('not found', 404)
    const adapter = createOllamaAltAdapter()
    try {
      await adapter.generate(makeInput())
      throw new Error('expected to throw')
    } catch (err) {
      if (err instanceof AIAdapterFailedError) {
        expect(err.message).toContain('404')
      }
    }
  })

  it('translates 500 errors', async () => {
    mockResponse('internal error', 500)
    const adapter = createOllamaAltAdapter()
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates network errors (Ollama not running)', async () => {
    mockNetworkError()
    const adapter = createOllamaAltAdapter()
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('error message hints at running Ollama on connection failure', async () => {
    mockNetworkError()
    const adapter = createOllamaAltAdapter()
    try {
      await adapter.generate(makeInput())
      throw new Error('expected to throw')
    } catch (err) {
      if (err instanceof AIAdapterFailedError) {
        expect(err.message.toLowerCase()).toContain('ollama')
      }
    }
  })

  it('throws AIAdapterFailedError when JSON has top-level error field', async () => {
    server.use(http.post(API_URL, () => HttpResponse.json({ error: 'context too long' })))
    const adapter = createOllamaAltAdapter()
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('throws AIInvalidResponseError when message.content is missing', async () => {
    server.use(
      http.post(API_URL, () =>
        HttpResponse.json({
          model: 'llama3.2-vision:11b',
          message: { role: 'assistant' }, // no content
          done: true,
        }),
      ),
    )
    const adapter = createOllamaAltAdapter()
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIInvalidResponseError)
  })

  it('throws AIInvalidResponseError when response is not JSON', async () => {
    server.use(http.post(API_URL, () => new HttpResponse('plain text not json', { status: 200 })))
    const adapter = createOllamaAltAdapter()
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIInvalidResponseError)
  })
})

describe('createOllamaAltAdapter — AbortSignal', () => {
  it('aborts an in-flight request when the signal fires', async () => {
    server.use(
      http.post(API_URL, async () => {
        await new Promise(resolve => setTimeout(resolve, 1000))
        return HttpResponse.json({
          model: 'llama3.2-vision:11b',
          message: { role: 'assistant', content: 'late' },
          done: true,
        })
      }),
    )
    const adapter = createOllamaAltAdapter()
    const controller = new AbortController()
    const promise = adapter.generate(makeInput(), controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(promise).rejects.toThrow()
  })

  it('does not start a request when signal already aborted', async () => {
    const requestSpy = vi.fn()
    server.use(
      http.post(API_URL, () => {
        requestSpy()
        return HttpResponse.json({
          model: 'llama3.2-vision:11b',
          message: { role: 'assistant', content: 'should not see' },
          done: true,
        })
      }),
    )
    const adapter = createOllamaAltAdapter()
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.generate(makeInput(), controller.signal)).rejects.toThrow()
    expect(requestSpy).not.toHaveBeenCalled()
  })
})

describe('createOllamaAltAdapter — custom baseUrl', () => {
  it('respects custom baseUrl for non-default Ollama installs', async () => {
    const customUrl = 'http://ollama-server.internal:11434'
    server.use(
      http.post(`${customUrl}/api/chat`, async ({ request }) => {
        captured.push({ body: (await request.json()) as CapturedRequest['body'] })
        return HttpResponse.json({
          model: 'llama3.2-vision:11b',
          message: { role: 'assistant', content: 'remote ok' },
          done: true,
        })
      }),
    )
    const adapter = createOllamaAltAdapter({ baseUrl: customUrl })
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('remote ok')
  })
})
