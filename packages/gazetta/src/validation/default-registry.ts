import { circularFragment } from './validators/circular-fragment.js'
import { dynamicRouteConflict } from './validators/dynamic-route-conflict.js'
import { referencedAssetExists } from './validators/referenced-asset-exists.js'
import { referencedFragmentExists } from './validators/referenced-fragment-exists.js'
import { referencedTemplateExists } from './validators/referenced-template-exists.js'
import { createValidatorRegistry, type ValidatorRegistry } from './registry.js'

/**
 * Default validator registry — populated with the Cut 1 reference-existence
 * validators. Cut 2 will extend this list with background-only validators
 * (orphaned-locale-file, unused-fragment); Cut 3 will add quality validators.
 *
 * Each validator declares its own stage support, so adding entries here is
 * safe: validators that don't apply to a given stage are filtered out by
 * `registry.forStage(stage)`.
 */
export function defaultValidatorRegistry(): ValidatorRegistry {
  return createValidatorRegistry([
    referencedAssetExists,
    referencedFragmentExists,
    referencedTemplateExists,
    circularFragment,
    dynamicRouteConflict,
  ])
}
