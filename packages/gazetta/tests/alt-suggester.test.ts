/**
 * Unit tests for `alt/suggester.ts` — orchestration:
 *
 *   - `available` delegates to adapter.supports
 *   - `suggest` returns null when adapter doesn't support the MIME
 *   - `suggest` builds AltRequest from input + defaults
 *   - `suggest` composes prompt and calls prepareForVision once each
 *   - `suggest` forwards AbortSignal to adapter
 *   - `suggest` returns null on aborted signal (pre-call)
 *   - `suggest` returns null on aborted signal (post-call rejection)
 *   - `suggest` returns null on AIError; rethrows non-AI errors
 *   - `suggest` returns AltSuggestion on success (including refused: true)
 *   - posterBytes are forwarded to prepareForVision
 *
 * Adapters in tests are recording mocks — they capture the
 * `AltGenerateInput` and return canned suggestions. Real provider
 * adapters with msw fixtures land in commits 3-5.
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { AIAdapterFailedError, AIAdapterUnavailableError } from '../src/ai/errors.js'
import { type AltGenerateInput, type AltSuggestion, type AltTextAdapter } from '../src/alt/adapter.js'
import { nullAltAdapter } from '../src/alt/null-adapter.js'
import { createAltSuggester } from '../src/alt/suggester.js'

async function makeJpeg(width = 200, height = 200): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

function makeRecordingAdapter(suggestion: AltSuggestion = makeSuggestion('Mountain at sunset')): {
  adapter: AltTextAdapter
  calls: AltGenerateInput[]
  signals: (AbortSignal | undefined)[]
} {
  const calls: AltGenerateInput[] = []
  const signals: (AbortSignal | undefined)[] = []
  const adapter: AltTextAdapter = {
    name: 'recording',
    supports(mime: string) {
      return mime.startsWith('image/')
    },
    async generate(input, signal) {
      calls.push(input)
      signals.push(signal)
      return suggestion
    },
  }
  return { adapter, calls, signals }
}

function makeSuggestion(text: string, refused = false): AltSuggestion {
  return { text, refused, refusalReason: refused ? text : null }
}

describe('available', () => {
  it('delegates to adapter.supports', () => {
    const { adapter } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    expect(suggester.available('image/jpeg')).toBe(true)
    expect(suggester.available('audio/mpeg')).toBe(false)
  })

  it('returns false with nullAltAdapter for any MIME', () => {
    const suggester = createAltSuggester({ adapter: nullAltAdapter })
    expect(suggester.available('image/jpeg')).toBe(false)
    expect(suggester.available('image/png')).toBe(false)
  })
})

describe('suggest — capability check', () => {
  it('returns null when adapter does not support the MIME', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const result = await suggester.suggest({
      bytes,
      mime: 'audio/mpeg',
      hash: 'abc',
    })
    expect(result).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns null with nullAltAdapter (never reaches generate)', async () => {
    const suggester = createAltSuggester({ adapter: nullAltAdapter })
    const bytes = await makeJpeg()
    const result = await suggester.suggest({
      bytes,
      mime: 'image/jpeg',
      hash: 'abc',
    })
    expect(result).toBeNull()
  })
})

describe('suggest — request building', () => {
  it('applies default locale when not provided', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(calls[0].request.locale).toBe('en')
  })

  it('applies default maxChars when not provided', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(calls[0].request.maxChars).toBe(125)
  })

  it('applies default style: descriptive', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(calls[0].request.style).toBe('descriptive')
  })

  it('uses provided locale when given', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc', locale: 'fr' })
    expect(calls[0].request.locale).toBe('fr')
  })

  it('uses provided maxChars when given', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc', maxChars: 250 })
    expect(calls[0].request.maxChars).toBe(250)
  })
})

describe('suggest — prompt + bytes prep', () => {
  it('composes a non-empty prompt and passes it to the adapter', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(calls[0].prompt.length).toBeGreaterThan(0)
    expect(calls[0].prompt).toContain('WCAG')
    expect(calls[0].prompt).toContain('125 characters')
  })

  it('includes locale paragraph in prompt when locale ≠ default', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc', locale: 'fr' })
    expect(calls[0].prompt).toContain('fr')
  })

  it('passes prepared bytes to the adapter (smaller than source after resize)', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    // Force a resize by using bytes larger than max edge.
    const bytes = await makeJpeg(2000, 2000)
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    // Prepared bytes should differ from source (after resize+re-encode).
    expect(calls[0].bytes).not.toBe(bytes)
    // Verify dimensions were resized.
    const meta = await sharp(calls[0].bytes).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768)
  })

  it('uses posterBytes when provided (animated-image path)', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const sourceBytes = await makeJpeg(2000, 2000)
    const posterBytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
    await suggester.suggest({
      bytes: sourceBytes,
      mime: 'image/gif',
      hash: 'abc',
      posterBytes: new Uint8Array(posterBytes),
    })
    // Adapter received the poster bytes verbatim (or a copy of them).
    expect(calls[0].bytes).toEqual(new Uint8Array(posterBytes))
    expect(calls[0].mime).toBe('image/png')
  })

  it('respects maxImageEdge override', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg(2000, 2000)
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc', maxImageEdge: 1024 })
    const meta = await sharp(calls[0].bytes).metadata()
    expect(meta.width).toBe(1024)
  })

  it('returns null when prepareForVision throws (corrupt bytes)', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    // Garbage bytes that sharp can't decode.
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const result = await suggester.suggest({ bytes: garbage, mime: 'image/jpeg', hash: 'abc' })
    expect(result).toBeNull()
    expect(calls).toHaveLength(0) // adapter never called
  })
})

describe('suggest — AbortSignal forwarding', () => {
  it('forwards the AbortSignal to adapter.generate', async () => {
    const { adapter, signals } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const controller = new AbortController()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' }, controller.signal)
    expect(signals[0]).toBe(controller.signal)
  })

  it('returns null when signal is already aborted', async () => {
    const { adapter, calls } = makeRecordingAdapter()
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const controller = new AbortController()
    controller.abort()
    const result = await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' }, controller.signal)
    expect(result).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns null when adapter throws after abort', async () => {
    const adapter: AltTextAdapter = {
      name: 'aborting',
      supports: () => true,
      async generate(_input, signal) {
        // Simulate adapter throwing because signal aborted mid-call.
        signal?.throwIfAborted()
        return makeSuggestion('unreachable')
      },
    }
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const controller = new AbortController()
    // Setup: pass a not-yet-aborted signal so the suggester proceeds,
    // but abort it before the adapter resolves. The adapter throws.
    const promise = suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' }, controller.signal)
    controller.abort()
    const result = await promise
    expect(result).toBeNull()
  })
})

describe('suggest — error handling', () => {
  it('returns null when adapter throws AIAdapterFailedError', async () => {
    const adapter: AltTextAdapter = {
      name: 'failing',
      supports: () => true,
      async generate() {
        throw new AIAdapterFailedError('upstream rejected')
      },
    }
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const result = await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(result).toBeNull()
  })

  it('returns null when adapter throws AIAdapterUnavailableError', async () => {
    const adapter: AltTextAdapter = {
      name: 'unavailable',
      supports: () => true,
      async generate() {
        throw new AIAdapterUnavailableError('something missing')
      },
    }
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const result = await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(result).toBeNull()
  })

  it('rethrows non-AI errors (programmer bugs surface)', async () => {
    const adapter: AltTextAdapter = {
      name: 'buggy',
      supports: () => true,
      async generate() {
        throw new TypeError('cannot read property of undefined')
      },
    }
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await expect(suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })).rejects.toBeInstanceOf(TypeError)
  })
})

describe('suggest — successful generation', () => {
  it('returns the adapter result on success', async () => {
    const expected = makeSuggestion('Trees in autumn')
    const { adapter } = makeRecordingAdapter(expected)
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const result = await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(result).toEqual(expected)
  })

  it('returns refusal verbatim from adapter', async () => {
    const refusal = makeSuggestion("I can't describe this image.", true)
    const { adapter } = makeRecordingAdapter(refusal)
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    const result = await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(result).toEqual(refusal)
    expect(result?.refused).toBe(true)
    expect(result?.refusalReason).not.toBeNull()
  })
})

describe('suggest — adapter is called exactly once per suggest call', () => {
  it('does not retry on its own', async () => {
    const adapter: AltTextAdapter = {
      name: 'flaky',
      supports: () => true,
      generate: vi.fn(async () => makeSuggestion('First call')),
    }
    const suggester = createAltSuggester({ adapter })
    const bytes = await makeJpeg()
    await suggester.suggest({ bytes, mime: 'image/jpeg', hash: 'abc' })
    expect(adapter.generate).toHaveBeenCalledTimes(1)
  })
})
