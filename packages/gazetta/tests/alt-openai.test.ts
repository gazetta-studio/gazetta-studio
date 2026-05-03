/**
 * Unit tests for `alt/openai.ts` — second provider adapter.
 *
 * Same test shape as Anthropic adapter (commit 3), validating that
 * the abstraction holds across providers. Uses `msw` to intercept
 * OpenAI API at the network layer; no real API calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { AIAdapterFailedError, AIInvalidResponseError } from '../src/ai/errors.js'
import { type AltGenerateInput, DEFAULT_ALT_REQUEST } from '../src/alt/adapter.js'
import { createOpenAIAltAdapter } from '../src/alt/openai.js'

const API_URL = 'https://api.openai.com/v1/chat/completions'

interface CapturedRequest {
  body: {
    model: string
    max_tokens?: number
    messages: Array<{
      role: string
      content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
    }>
  }
  headers: Headers
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
      captured.push({
        body: (await request.json()) as CapturedRequest['body'],
        headers: request.headers,
      })
      if (status !== 200) {
        return HttpResponse.json({ error: { message: text, type: 'api_error' } }, { status })
      }
      return HttpResponse.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
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

describe('createOpenAIAltAdapter — basic', () => {
  it('exposes name "openai"', () => {
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    expect(adapter.name).toBe('openai')
  })

  it('supports OpenAI-accepted image MIMEs', () => {
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    expect(adapter.supports('image/jpeg')).toBe(true)
    expect(adapter.supports('image/png')).toBe(true)
    expect(adapter.supports('image/gif')).toBe(true)
    expect(adapter.supports('image/webp')).toBe(true)
  })

  it('rejects unsupported MIMEs', () => {
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    expect(adapter.supports('image/svg+xml')).toBe(false)
    expect(adapter.supports('audio/mpeg')).toBe(false)
  })
})

describe('createOpenAIAltAdapter — happy path', () => {
  it('returns the model output verbatim', async () => {
    mockResponse('Mountain at sunset')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('Mountain at sunset')
    expect(result.refused).toBe(false)
    expect(result.refusalReason).toBeNull()
  })

  it('trims whitespace from output', async () => {
    mockResponse('  Trees in autumn.\n  ')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('Trees in autumn.')
  })

  it('uses configured model', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0, model: 'gpt-4o' })
    await adapter.generate(makeInput())
    expect(captured[0].body.model).toBe('gpt-4o')
  })

  it('defaults to gpt-4o-mini', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(makeInput())
    expect(captured[0].body.model).toBe('gpt-4o-mini')
  })

  it('routes the composed prompt as a system message', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(makeInput({ prompt: 'Custom system prompt.' }))
    const sys = captured[0].body.messages.find(m => m.role === 'system')
    expect(sys).toBeDefined()
    expect(sys?.content).toBe('Custom system prompt.')
  })

  it('derives max_tokens from request.maxChars (≈4 chars/token)', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(
      makeInput({
        request: { ...DEFAULT_ALT_REQUEST, maxChars: 400 },
      }),
    )
    expect(captured[0].body.max_tokens).toBe(100)
  })

  it('floors max_tokens at 64 for short maxChars', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(
      makeInput({
        request: { ...DEFAULT_ALT_REQUEST, maxChars: 50 },
      }),
    )
    expect(captured[0].body.max_tokens).toBe(64)
  })

  it('encodes image bytes as a base64 data URL', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    await adapter.generate(makeInput({ bytes }))
    const userMsg = captured[0].body.messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(Array.isArray(userMsg?.content)).toBe(true)
    if (Array.isArray(userMsg?.content)) {
      const block = userMsg.content[0]
      expect(block.type).toBe('image_url')
      if (block.type === 'image_url') {
        const expectedB64 = Buffer.from(bytes).toString('base64')
        expect(block.image_url.url).toBe(`data:image/jpeg;base64,${expectedB64}`)
      }
    }
  })

  it('passes the asset MIME through in the data URL', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(makeInput({ mime: 'image/png' }))
    const userMsg = captured[0].body.messages.find(m => m.role === 'user')
    if (Array.isArray(userMsg?.content)) {
      const block = userMsg.content[0]
      if (block.type === 'image_url') {
        expect(block.image_url.url.startsWith('data:image/png;base64,')).toBe(true)
      }
    }
  })
})

describe('createOpenAIAltAdapter — refusal', () => {
  it('detects shared refusal markers', async () => {
    mockResponse("I can't describe this image.")
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(true)
  })

  it('detects OpenAI-specific "I\'m sorry, I can\'t assist"', async () => {
    mockResponse("I'm sorry, I can't assist with this request.")
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(true)
  })

  it('passes through normal descriptions as not-refused', async () => {
    mockResponse('A cat sitting on a windowsill in the morning sun.')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(false)
  })
})

describe('createOpenAIAltAdapter — errors', () => {
  it('translates 401 auth errors to AIAdapterFailedError', async () => {
    mockResponse('invalid api key', 401)
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-bad', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates 429 rate-limit errors', async () => {
    mockResponse('rate limited', 429)
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates 500 errors', async () => {
    mockResponse('internal error', 500)
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates network errors', async () => {
    mockNetworkError()
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('preserves the underlying SDK error as cause', async () => {
    mockResponse('rate limited', 429)
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    try {
      await adapter.generate(makeInput())
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AIAdapterFailedError)
      if (err instanceof AIAdapterFailedError) {
        expect(err.cause).toBeDefined()
      }
    }
  })

  it('throws AIInvalidResponseError when message has no text content', async () => {
    server.use(
      http.post(API_URL, () =>
        HttpResponse.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              // null content — happens when the model returns tool calls.
              message: { role: 'assistant', content: null },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
        }),
      ),
    )
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIInvalidResponseError)
  })
})

describe('createOpenAIAltAdapter — AbortSignal', () => {
  it('aborts an in-flight request when the signal fires', async () => {
    server.use(
      http.post(API_URL, async () => {
        await new Promise(resolve => setTimeout(resolve, 1000))
        return HttpResponse.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        })
      }),
    )
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
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
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'should not see' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        })
      }),
    )
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.generate(makeInput(), controller.signal)).rejects.toThrow()
    expect(requestSpy).not.toHaveBeenCalled()
  })
})

describe('createOpenAIAltAdapter — auth', () => {
  it('sends the API key in the Authorization header as Bearer', async () => {
    mockResponse('ok')
    const adapter = createOpenAIAltAdapter({ apiKey: 'sk-mytestkey', maxRetries: 0 })
    await adapter.generate(makeInput())
    expect(captured[0].headers.get('authorization')).toBe('Bearer sk-mytestkey')
  })
})
