import { accessibility } from './validators/accessibility.js'
import { altRequired } from './validators/alt-required.js'
import { brokenLinks } from './validators/broken-links.js'
import { circularFragment } from './validators/circular-fragment.js'
import { dynamicRouteConflict } from './validators/dynamic-route-conflict.js'
import { htmlValidity } from './validators/html-validity.js'
import { orphanedLocaleFile } from './validators/orphaned-locale-file.js'
import { referencedAssetExists } from './validators/referenced-asset-exists.js'
import { referencedFragmentExists } from './validators/referenced-fragment-exists.js'
import { referencedTemplateExists } from './validators/referenced-template-exists.js'
import { schemaConformance } from './validators/schema-conformance.js'
import { unusedFragment } from './validators/unused-fragment.js'
import { createValidatorRegistry, type ValidatorRegistry } from './registry.js'

/**
 * Default validator registry — Cut 1 (ref-existence) + Cut 2 (background-
 * only) + Cut 3 (quality: a11y, html-validity, altRequired) + Cut 4
 * (broken-links).
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
    schemaConformance,
    orphanedLocaleFile,
    unusedFragment,
    altRequired,
    htmlValidity,
    accessibility,
    brokenLinks,
  ])
}
