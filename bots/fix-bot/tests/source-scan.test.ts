/**
 * Coverage for the `extractFunctionBody` helper in `_helpers/source-scan.ts`.
 *
 * The helper was previously inlined in `push-force-with-lease.test.ts:24-52`
 * and shadowed by two fragile
 *   `/async function <name>\([\s\S]+?\n\}\n/`
 * regexes in `escalate-to-human-reset.test.ts` + `past-pr-skip-list-reset.test.ts`.
 *
 * These tests target the helper's INTERFACE — what body-substring must
 * come back for a given source shape — and each non-trivial test carries
 * a named counterfactual mutation the assertion would catch (per
 * review-bot coverage-shape recipe anti-tautology discipline).
 */
import { describe, expect, it } from 'vitest'
import { extractFunctionBody } from './_helpers/source-scan.ts'

describe('extractFunctionBody', () => {
  it('returns a body string bracketed by `{` and `}`', () => {
    // Anti-tautology counterfactual: if the helper returned the full
    // function declaration (from `function` keyword onwards), the
    // startsWith('{') assertion fails. If it returned only the inside
    // of the braces, the endsWith('}') assertion fails.
    const src = 'function pushBranch() { return 42 }\n'
    const body = extractFunctionBody(src, 'pushBranch')
    expect(body.startsWith('{')).toBe(true)
    expect(body.endsWith('}')).toBe(true)
    expect(body).toContain('return 42')
  })

  it('extracts an async function body (recognises the `async` keyword)', () => {
    // Anti-tautology counterfactual: if the decl regex omitted the
    // `(?:async\s+)?` alternation, this call throws — because
    // `function escalateToHuman` wouldn't match `async function escalateToHuman`.
    const src = 'async function escalateToHuman() { await stuff() }\n'
    const body = extractFunctionBody(src, 'escalateToHuman')
    expect(body).toContain('await stuff()')
  })

  it('throws when the named function is not found (not silent empty string)', () => {
    // Anti-tautology counterfactual: if the helper silently returned
    // `''` for a missing function, downstream callers' `expect(body).toMatch(...)`
    // assertions would all pass tautologically (nothing matches, but nothing
    // is required either — depending on which matchers). More importantly, a
    // typo in the function name would silently pass a structural test that
    // never actually inspects any function. Throwing is the load-bearing
    // fail-loud path.
    const src = 'function actuallyExists() { return 1 }\n'
    expect(() => extractFunctionBody(src, 'doesNotExist')).toThrow(/doesNotExist/)
  })

  it('skips braces inside default-parameter values before entering the body', () => {
    // Anti-tautology counterfactual: a naive `src.indexOf('{')` from
    // the function decl's start would find the `{` inside the default
    // parameter `x = { a: 1 }` and treat that as the body's opening
    // brace. The returned body would then close at `}` after `a: 1`,
    // never reaching `return x`. The paren-depth skip past the
    // parameter list is what makes this work.
    const src = 'function withDefault(x = { a: 1 }) { return x }\n'
    const body = extractFunctionBody(src, 'withDefault')
    expect(body).toContain('return x')
    // And the `a: 1` default value must NOT be considered part of the body:
    // it lives inside the parameter list.
    expect(body).not.toContain('a: 1')
  })

  it('handles nested blocks whose closing `}` sits at column 0', () => {
    // Anti-tautology counterfactual — the load-bearing motivation for
    // this whole refactor:
    //
    // The fragile regex `/function outer\([\s\S]+?\n\}\n/` matches
    // lazily up to the first `\n}\n` (a `}` at column 0). If any
    // nested block's `}` accidentally sits at column 0 (which
    // biome/prettier reformats or nested-function refactors can
    // produce), the regex truncates the body mid-function and misses
    // `return 'outer-tail'`. Brace-depth counting doesn't care about
    // indentation.
    const src =
      'function outer() {\n' +
      '  if (true) {\n' +
      '}\n' + // <- nested `}` at column 0 (adversarial formatting)
      "  return 'outer-tail'\n" +
      '}\n'
    const body = extractFunctionBody(src, 'outer')
    expect(body).toContain("return 'outer-tail'")
  })

  it('extracts the function matching the requested name, not just the first function in source', () => {
    // Anti-tautology counterfactual: if the helper searched for
    // `function\s*\(` (ignoring the name), the source below would
    // return the body of `firstFn` regardless of which name was
    // requested. This test proves the name is load-bearing to the
    // lookup — critical for the three call sites that each extract a
    // different named function from the SAME `index.ts` source.
    const src =
      'function firstFn() { return "first" }\n' +
      'function secondFn() { return "second" }\n' +
      'async function thirdFn() { return "third" }\n'
    expect(extractFunctionBody(src, 'firstFn')).toContain('"first"')
    expect(extractFunctionBody(src, 'secondFn')).toContain('"second"')
    expect(extractFunctionBody(src, 'thirdFn')).toContain('"third"')
    // Cross-check: secondFn's body must not leak into firstFn's slice.
    expect(extractFunctionBody(src, 'firstFn')).not.toContain('"second"')
  })
})
