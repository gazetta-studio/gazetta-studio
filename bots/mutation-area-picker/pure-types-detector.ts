/**
 * Detects pure-type files — TypeScript source whose compiled JS emits
 * zero runtime code. Stryker generates 0 mutants for such files: types
 * are erased at compile time, leaving nothing to mutate.
 *
 * Reason for existence: mutation-area-picker proposed adding
 * `packages/gazetta/src/audit/types.ts` (183 lines of `export type`
 * / `export interface`) to the mutate glob (PR #700, closed as one-off).
 * The inclusion score's five signals (AI-pairing density, churn,
 * test/source LOC ratio, flake/bug correlation) have no gate for
 * "does this file produce mutants at all?", so a freshly-touched
 * type file scores high on churn + AI-density and gets nominated
 * over its runtime siblings. Worse, a scoped zero-mutant file
 * registers as vacuously 100% killed (0/0), which the eviction
 * rule reads as "graduated well-covered module" — burning a glob
 * slot for no signal.
 *
 * This predicate runs at candidate-enumeration time (before scoring
 * and before the decision tree), symmetric to the barrel-detector.
 * The pre-filter must run BEFORE the weighted inclusion score so
 * high churn / AI-density signals on a pure-type file can't override
 * it (issue #706 acceptance criterion).
 *
 * Heuristic direction: err toward INCLUDING per issue #706. A
 * false-negative (index a mutable file as mutable) costs nothing;
 * a false-positive (exclude a genuinely mutable file) is the
 * harmful case. Runtime-value patterns are broad; type-only shape
 * has to satisfy ALL of them being absent.
 */

/**
 * Returns true when `source` is a pure-type TypeScript file — its
 * compiled JS output contains zero mutation-testable code.
 *
 * Detection scans for any of:
 *
 *   - top-of-line value declarations (`const|let|var|function|class|
 *     enum|async function`, optionally prefixed with `export` and
 *     optionally `default`)
 *   - `export default <expression>`
 *   - `as const` (tuple / const assertion)
 *   - `satisfies` (expression form)
 *   - side-effect imports (`import './x.js'` — could mutate global
 *     state; safer to include)
 *
 * Comments are stripped first so prose in JSDoc doesn't produce
 * false positives when narrative uses words like "const" or
 * "satisfies".
 */
export function isPureTypesFile(source: string): boolean {
  const stripped = stripComments(source)
  return !RUNTIME_VALUE_PATTERN.test(stripped)
}

/**
 * Returns the count of runtime-value declarations detected in `source`.
 * Match count roughly approximates mutation surface — Stryker mutates
 * expressions inside function/const/class bodies, so the number of
 * top-level (and inner) declarations bounds what's available to mutate.
 *
 * `isPureTypesFile` is the special case `mutableSurfaceLineCount === 0`;
 * kept as its own predicate for the early-exit `.test()` optimization
 * (regex short-circuits on first match; counting requires a full scan).
 */
export function mutableSurfaceLineCount(source: string): number {
  const stripped = stripComments(source)
  return (stripped.match(RUNTIME_VALUE_PATTERN_GLOBAL) ?? []).length
}

/**
 * Returns the count of non-comment, non-blank lines in `source` — a
 * cheap proxy for "how big is this file" that excludes JSDoc and
 * whitespace bulk.
 *
 * Used together with `mutableSurfaceLineCount` by
 * `isSparseMutationSurface` to distinguish a legitimate small utility
 * (1 function in 5 lines) from a near-pure-types file (1 function in
 * 30+ lines of `export type` / `export interface`).
 */
export function meaningfulLineCount(source: string): number {
  const stripped = stripComments(source)
  let count = 0
  for (const line of stripped.split('\n')) {
    if (line.trim().length > 0) count++
  }
  return count
}

export interface SparseSurfaceThresholds {
  /** Below this many runtime declarations, the file is a candidate for
   *  demotion — but only if it's also large. Default 3. */
  minDeclarations?: number
  /** Above this many meaningful lines, a low-declaration file is
   *  demoted. Small utility files below this line count pass through
   *  regardless of declaration count. Default 20. */
  maxLinesWithoutMinDeclarations?: number
}

/**
 * Returns true when `source` has few runtime-value declarations
 * relative to its size — the "near-pure-types" shape that motivates
 * issue #723: a large file (~30+ meaningful lines) with only 1-2
 * mutable declarations wastes a glob slot for negligible coverage
 * signal.
 *
 * The two-threshold gate keeps small utility files (1-2 functions in
 * a handful of lines) as normal candidates while catching the actual
 * failure mode. A file must fail BOTH gates to be classified sparse:
 * few declarations AND large enough that a real module would have
 * more of them.
 *
 * Existence rationale: mutation-area-picker nominated
 * `packages/gazetta/src/validation/types.ts` (~150 lines, 1 function)
 * after churn from unrelated dead-code un-exports (#716/#717) inflated
 * its inclusion score. The presence-only #708 filter passed it because
 * one runtime line satisfies the ≥1 gate. Size-aware counting closes
 * the compounding gap.
 */
export function isSparseMutationSurface(source: string, thresholds: SparseSurfaceThresholds = {}): boolean {
  const minDeclarations = thresholds.minDeclarations ?? 3
  const maxLinesWithoutMin = thresholds.maxLinesWithoutMinDeclarations ?? 20
  if (mutableSurfaceLineCount(source) >= minDeclarations) return false
  return meaningfulLineCount(source) > maxLinesWithoutMin
}

// One combined regex, cheaper than N separate tests. Each alternative
// is anchored (line-start `(?:^|\n)\s*`) or word-bounded (`\b`) so the
// substrings can't false-match inside identifiers or string bodies.
const RUNTIME_VALUE_PATTERN = new RegExp(
  [
    // Value declaration keywords at line start, with optional export/default prefix.
    // Order-of-alternation caveat: `async function` before `function` so the
    // async form is preferred; `\b` ensures we don't half-match `functional`.
    String.raw`(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:const|let|var|async\s+function|function|class|enum)\b`,
    // `export default <expression>` where the expression isn't a decl keyword
    // (already matched above). Catches `export default { ... }` and friends.
    String.raw`(?:^|\n)\s*export\s+default\b`,
    // `as const` / `as   const`.
    String.raw`\bas\s+const\b`,
    // `satisfies X` (expression form; requires a value on the left).
    String.raw`\bsatisfies\b`,
    // Side-effect import: `import './polyfill.js'` (no bindings).
    // TypeScript doesn't erase these; the emitted JS runs the module for
    // side effects. Cannot reliably distinguish from a benign no-op, so
    // treat as runtime per rule 706 (err toward including).
    String.raw`(?:^|\n)\s*import\s+['"][^'"]+['"]`,
  ].join('|'),
)

// Same alternation as RUNTIME_VALUE_PATTERN but with the `g` flag so
// `.match()` returns all matches, not just the first. Kept separate so
// isPureTypesFile's `.test()` can use the non-global form without the
// stateful `lastIndex` gotcha that `g`-flag `.test()` calls have.
const RUNTIME_VALUE_PATTERN_GLOBAL = new RegExp(RUNTIME_VALUE_PATTERN.source, 'g')

// Strip block and line comments before scanning. Doesn't need to be
// a perfect tokenizer — pure-type files don't contain comment markers
// inside string literals that also happen to sit adjacent to fake
// declaration keywords. If a real edge case surfaces, tighten here.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}
