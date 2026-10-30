/**
 * Every relation a dependency index is kept for. Code that writes or
 * wipes a whole item's edges iterates this list, so a new relation is
 * added here once.
 */
import { ARCHIVE_ALIASES } from './archive-aliases.js'
import { ASSET_REFS } from './assets/asset-deps.js'
import type { DepRelation } from './dep-sidecars.js'
import { FRAGMENT_DEPS } from './fragment-deps.js'

export const DEP_RELATIONS: readonly DepRelation[] = [FRAGMENT_DEPS, ASSET_REFS, ARCHIVE_ALIASES]
