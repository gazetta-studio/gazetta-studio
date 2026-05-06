/**
 * `gazetta/testing` — test helpers for plugin authors and contributors.
 *
 * Imports here pull in `vitest` as a peer dependency. Plugin authors
 * who use this barrel must have vitest in their devDependencies.
 *
 * Why a separate subpath: keeps vitest off the main `gazetta` import
 * graph, so production deployments never bundle test-only code.
 */
export {
  adminCacheContractTests,
  type AdminCacheContractOptions,
  type AdminCacheFactory,
} from './admin-cache-contract.js'
