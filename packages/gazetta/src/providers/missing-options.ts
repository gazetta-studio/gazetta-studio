/**
 * Required options a provider factory was called without (#1185). The
 * factory still returns a provider, whose first use throws the message;
 * `gazetta validate` lists these through `missingOptionsOf`.
 */
export interface MissingOption {
  /** The factory option, as the operator writes it (`accessKeyId`). */
  readonly option: string
  /** What the provider throws on first use. */
  readonly message: string
}

interface Checked {
  readonly option: string
  readonly value: unknown
  readonly message: string
}

/**
 * `Symbol.for`, not `Symbol()`: the operator's `site.config.ts` imports a
 * separate copy of this module through jiti, and only registry symbols are
 * the same across copies.
 */
const MISSING_OPTIONS = Symbol.for('gazetta.missingOptions')

/** The checks whose value is empty. */
export function findMissing(checks: readonly Checked[]): MissingOption[] {
  return checks.filter(c => !c.value).map(({ option, message }) => ({ option, message }))
}

/** One message naming every missing option, for the provider to throw. */
export function missingMessage(missing: readonly MissingOption[]): string {
  return missing.map(m => m.message).join('\n')
}

/** `value`, marked with the options its factory was missing. */
export function withMissingOptions<T extends object>(value: T, missing: readonly MissingOption[]): T {
  Object.defineProperty(value, MISSING_OPTIONS, { value: missing, enumerable: false })
  return value
}

/** The required options `value`'s factory was called without; empty for a provider or adapter that's complete. */
export function missingOptionsOf(value: unknown): readonly MissingOption[] {
  if (typeof value !== 'object' || value === null) return []
  return (value as { [MISSING_OPTIONS]?: readonly MissingOption[] })[MISSING_OPTIONS] ?? []
}
