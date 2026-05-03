/**
 * Unit tests for `ai/compose-prompt.ts` — generic composer behavior.
 * Tests use a synthetic request type to avoid coupling to any specific
 * task; alt-text-specific policies live in `alt/prompt-policies.ts`
 * with their own tests.
 */
import { describe, expect, it } from 'vitest'
import { composePrompt, type PromptPolicy } from '../src/ai/compose-prompt.js'

interface TestRequest {
  flag: boolean
  value: string
}

describe('composePrompt', () => {
  it('joins non-empty policy outputs with paragraph breaks', () => {
    const policies: PromptPolicy<TestRequest>[] = [
      () => 'First paragraph.',
      () => 'Second paragraph.',
      () => 'Third paragraph.',
    ]
    const result = composePrompt({ flag: true, value: 'x' }, policies)
    expect(result).toBe('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.')
  })

  it('drops empty-string policy outputs from the result', () => {
    const policies: PromptPolicy<TestRequest>[] = [() => 'Included.', () => '', () => 'Also included.']
    const result = composePrompt({ flag: true, value: 'x' }, policies)
    expect(result).toBe('Included.\n\nAlso included.')
    expect(result).not.toContain('\n\n\n\n')
  })

  it('returns empty string when all policies produce empty', () => {
    const policies: PromptPolicy<TestRequest>[] = [() => '', () => '', () => '']
    const result = composePrompt({ flag: false, value: '' }, policies)
    expect(result).toBe('')
  })

  it('preserves order of non-empty policies', () => {
    const policies: PromptPolicy<TestRequest>[] = [() => 'C', () => '', () => 'A', () => '', () => 'B']
    const result = composePrompt({ flag: true, value: 'x' }, policies)
    expect(result).toBe('C\n\nA\n\nB')
  })

  it('passes the request through to each policy', () => {
    const calls: TestRequest[] = []
    const policies: PromptPolicy<TestRequest>[] = [
      req => {
        calls.push(req)
        return 'p1'
      },
      req => {
        calls.push(req)
        return 'p2'
      },
    ]
    const req: TestRequest = { flag: true, value: 'hello' }
    composePrompt(req, policies)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(req)
    expect(calls[1]).toBe(req)
  })

  it('handles a single-policy array', () => {
    const policies: PromptPolicy<TestRequest>[] = [() => 'only']
    expect(composePrompt({ flag: true, value: 'x' }, policies)).toBe('only')
  })

  it('handles an empty policies array', () => {
    expect(composePrompt({ flag: true, value: 'x' }, [])).toBe('')
  })

  it('is generic over request type', () => {
    // Type-system check: composePrompt works with any T.
    interface OtherRequest {
      n: number
    }
    const policies: PromptPolicy<OtherRequest>[] = [req => `n=${req.n}`]
    expect(composePrompt({ n: 42 }, policies)).toBe('n=42')
  })
})
