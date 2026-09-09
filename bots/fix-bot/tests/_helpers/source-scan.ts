/**
 * Test-infrastructure helpers for scanning bot source files.
 *
 * Used by structural tests that assert ordering / call-site invariants
 * inside function bodies. The alternative — mocking `execFileSync` +
 * octokit + fs to observe behavior — costs more than the assertion
 * gains. Structural source-scan is the right tier for these ordering
 * invariants (see `escalate-to-human-reset.test.ts` head comment).
 */

/**
 * Extracts the body of a top-level function or async function by name.
 * Returns the substring from `{` through the matching `}` inclusive.
 * Throws when the named function is not found.
 *
 * Uses brace-depth counting so it survives:
 *   - Nested `{...}` blocks in the body (whether or not any nested `}` sits at column 0)
 *   - Braces in default-parameter values (e.g. `f(x = { a: 1 })`)
 *   - Multi-line function signatures
 *   - Biome / prettier reformatting that changes indentation
 *
 * The earlier `/async function <name>\([\s\S]+?\n\}\n/` regex approach
 * fails on any of those cases; extracting this helper is the fix to
 * three call sites (per CLAUDE.md "extract shared code when 3+ callers
 * exist").
 */
export function extractFunctionBody(src: string, name: string): string {
  const decl = new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(`)
  const match = decl.exec(src)
  if (!match) throw new Error(`function ${name} not found in source`)
  const openParen = src.indexOf('(', match.index)
  // Skip past the parameter list to the function's opening brace
  let depth = 0
  let i = openParen
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  const bodyStart = src.indexOf('{', i)
  depth = 0
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(bodyStart, j + 1)
    }
  }
  throw new Error(`could not extract body of ${name}`)
}
