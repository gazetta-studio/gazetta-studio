/**
 * Ollama adapter — alt-text via the local `/api/chat` endpoint.
 *
 * # Why no SDK
 *
 * Ollama's API is a single endpoint, no auth, no streaming
 * negotiation, no schema beyond simple JSON. The official
 * `ollama` npm SDK exists but adds little value over raw `fetch`
 * for this single-call use case. Skipping the SDK keeps adapter
 * dependencies minimal.
 *
 * # Defaults
 *
 *   - Base URL: `http://localhost:11434` (Ollama's documented default).
 *     Operators running Ollama on a different host configure via
 *     `OLLAMA_BASE_URL` env (factory) or `baseUrl` (direct).
 *   - Model: `llama3.2-vision:11b`. The 11B variant is the entry-level
 *     size; `:90b` is also available for operators who want better
 *     description quality at higher GPU/RAM cost.
 *
 * # API contract details (verified against Ollama API docs)
 *
 *   - Endpoint: `POST /api/chat` (not `/api/generate` — chat-style is
 *     better for multi-message prompts and matches the system+user
 *     pattern we use)
 *   - Request body:
 *     ```json
 *     {
 *       "model": "llama3.2-vision:11b",
 *       "messages": [
 *         { "role": "system", "content": "<prompt>" },
 *         { "role": "user", "content": "Describe this.", "images": ["<base64>"] }
 *       ],
 *       "stream": false
 *     }
 *     ```
 *   - Images are base64 strings in the per-message `images` array (NOT
 *     top-level). Different from Anthropic and OpenAI shapes — same
 *     adapter abstraction holds.
 *   - Response: `{ message: { content: "..." }, done: true, ... }`
 *   - Auth: none for local install; we don't send credentials
 *   - AbortSignal: standard fetch — `fetch(url, { signal })` aborts
 *     correctly
 *
 * # SOLID
 *
 *   - SRP: Ollama-specific request/response/error shape only
 *   - LSP: third concrete `AltTextAdapter` — same contract as
 *     Anthropic and OpenAI; substitutable in the suggester
 *   - DIP: callers get `AltTextAdapter`; never see fetch URLs or
 *     Ollama-specific JSON shapes
 */
import { AIAdapterFailedError, AIInvalidResponseError } from '../ai/errors.js'
import { detectRefusal } from '../ai/refusal.js'
import type { AltGenerateInput, AltSuggestion, AltTextAdapter } from './adapter.js'

const OLLAMA_REFUSAL_MARKERS: readonly string[] = [
  // llama3.2-vision tends to refuse with these patterns more than
  // saas providers; markers maintained per [refusal.ts] convention.
  "i'm not able to process this image",
  'i am not able to process this image',
  'sorry, i cannot',
]

/** Default base URL when running Ollama locally with default settings. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434'

/** Default model. Ollama Library publishes 11B and 90B variants of llama3.2-vision. */
export const OLLAMA_DEFAULT_MODEL = 'llama3.2-vision:11b'

const OLLAMA_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png'])

export interface OllamaAltAdapterOptions {
  /** Base URL of the Ollama server. Defaults to {@link OLLAMA_DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** Model ID. Defaults to {@link OLLAMA_DEFAULT_MODEL}. */
  model?: string
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string }
  done?: boolean
  error?: string
}

/**
 * Construct the Ollama alt-text adapter. Pure factory — no env-var
 * reads inside the adapter. The factory in commit 6 reads
 * `OLLAMA_BASE_URL` if present and forwards it as `baseUrl`.
 */
export function createOllamaAltAdapter(opts: OllamaAltAdapterOptions = {}): AltTextAdapter {
  const baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = opts.model ?? OLLAMA_DEFAULT_MODEL
  const endpoint = `${baseUrl}/api/chat`

  return {
    name: 'ollama',
    supports(mime: string) {
      return OLLAMA_SUPPORTED_MIMES.has(mime)
    },
    async generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion> {
      const imageB64 = Buffer.from(input.bytes).toString('base64')

      const body = {
        model,
        messages: [
          { role: 'system', content: input.prompt },
          {
            role: 'user',
            content: 'Describe this image for use as alt text.',
            images: [imageB64],
          },
        ],
        stream: false,
      }

      let res: Response
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
      } catch (err) {
        // AbortError on signal; let it propagate so the suggester's
        // signal.aborted check returns null.
        if (err instanceof Error && err.name === 'AbortError') throw err
        if (err instanceof Error) {
          throw new AIAdapterFailedError(
            `Ollama alt-text generation failed: ${err.message}. Is Ollama running at ${baseUrl}?`,
            { cause: err },
          )
        }
        throw new AIAdapterFailedError(`Ollama alt-text generation failed: unknown error`)
      }

      if (!res.ok) {
        // Ollama returns plain-text errors for connection-level issues
        // and JSON `{ error: "..." }` for model-level issues. Surface
        // both as AIAdapterFailedError; the message includes status
        // code so logs can disambiguate (404 → model not pulled, 400
        // → malformed request, etc.).
        let detail = `HTTP ${res.status}`
        try {
          const errorBody = await res.text()
          if (errorBody) detail += `: ${errorBody.slice(0, 200)}`
        } catch {
          // Body unreadable; status code alone is the diagnostic.
        }
        throw new AIAdapterFailedError(`Ollama alt-text generation failed: ${detail}`)
      }

      let parsed: OllamaChatResponse
      try {
        parsed = (await res.json()) as OllamaChatResponse
      } catch (err) {
        throw new AIInvalidResponseError(
          `Ollama returned non-JSON response: ${err instanceof Error ? err.message : 'unknown'}`,
        )
      }

      if (parsed.error) {
        throw new AIAdapterFailedError(`Ollama: ${parsed.error}`)
      }
      if (typeof parsed.message?.content !== 'string') {
        throw new AIInvalidResponseError('Ollama response had no message.content')
      }

      const text = parsed.message.content.trim()
      const refusal = detectRefusal(text, OLLAMA_REFUSAL_MARKERS)
      return {
        text,
        refused: refusal.refused,
        refusalReason: refusal.reason,
      }
    },
  }
}
