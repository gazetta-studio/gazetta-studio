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

// Strip block and line comments before scanning. Doesn't need to be
// a perfect tokenizer — pure-type files don't contain comment markers
// inside string literals that also happen to sit adjacent to fake
// declaration keywords. If a real edge case surfaces, tighten here.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}
