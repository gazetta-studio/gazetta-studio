/**
 * Detects pure re-export barrels — source files whose only exports are
 * `export ... from '...'` statements. These have no behavioral surface
 * that mutation testing can meaningfully cover: Stryker mutates the
 * `from` string literals, but no runtime test can catch those (the
 * public-surface contract is "this name is re-exported," enforced by
 * typecheck + import, not by runtime behavior). Adding a barrel to the
 * mutate glob produces NoCoverage noise, not signal.
 *
 * Reason for existence: mutation-area-picker proposed
 * `packages/gazetta/src/transforms/index.ts` (a barrel) twice in a row
 * (PRs #646 and #657, both closed). The stryker-config.test.ts guard
 * catches barrels at PR-review time but the bot re-picked the same
 * file because discovery had no barrel filter. This predicate is
 * applied at candidate-enumeration time, before scoring, so barrels
 * never reach the decision tree.
 *
 * The predicate mirrors the check inlined at
 * packages/gazetta/tests/stryker-config.test.ts's "no literal mutate
 * path is a pure re-export barrel" test. Two layers of defense: this
 * one is the primary prevention (bot-side); the stryker-config test
 * is the belt-and-suspenders guard (config-side).
 */

/**
 * Returns true when `source` is a pure re-export barrel — every export
 * statement has a `from '...'` clause and no direct `export const /
 * function / class / async function / default` is present.
 *
 * A file with zero exports is NOT a barrel — it has nothing to
 * re-export; treating it as one would falsely exclude modules that
 * happen to have no top-level exports but real behavior (e.g., a
 * script whose only surface is side effects at import).
 */
export function isReExportBarrel(source: string): boolean {
  const hasDirectExport = /^export\s+(const|function|class|async\s+function|default)\s/m.test(source)
  if (hasDirectExport) return false
  const exportLines = source.match(/^\s*export\s+/gm) ?? []
  // `export * from '...'` / `export * as X from '...'` / `export type { X } from '...'` /
  // `export { X } from '...'` all satisfy the re-export shape via the `from '...'` tail.
  const reExportLines = source.match(/^\s*export\s+(\*|type\s+\{|\{)[^]*?from\s+['"]/gm) ?? []
  return exportLines.length > 0 && exportLines.length === reExportLines.length
}
