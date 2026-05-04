import type { ValidationStage, Validator } from './types.js'

/**
 * Registry of validators keyed by stage. Cut 1 ships with 5 reference-existence
 * validators; Cut 2 adds background-only validators (orphaned-locale-file,
 * unused-fragment); Cut 3 adds quality validators (axe-core, html-validate).
 *
 * The registry is the single dispatch surface — `runSaveDelta` /
 * `runBackgroundScan` / publish-gate / `gazetta validate` all consume the same
 * registry, filtering by stage. Adding a new validator is one new file + one
 * line in `defaultRegistry()`.
 *
 * DIP: orchestrators depend on this abstraction, not on individual validators.
 */
export interface ValidatorRegistry {
  /** All registered validators. */
  all(): readonly Validator[]
  /** Validators that declare support for `stage`. */
  forStage(stage: ValidationStage): readonly Validator[]
  /** Add a validator at runtime — used by tests and (future) plugin consumers. */
  register(validator: Validator): void
}

export function createValidatorRegistry(initial: readonly Validator[] = []): ValidatorRegistry {
  const validators: Validator[] = [...initial]
  return {
    all() {
      return validators
    },
    forStage(stage) {
      return validators.filter(v => v.stages.includes(stage))
    },
    register(validator) {
      validators.push(validator)
    },
  }
}
