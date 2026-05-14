/**
 * The Node.js engines floor for both this repo's `package.json` AND for new
 * sites scaffolded via `gazetta init`. Centralized so a bump to the floor
 * only edits this file; callers (CLI template + engines-pinning tests) read
 * from here.
 *
 * Current floor reason: `write-file-atomic@8` declares
 * `engines: "^22.22.2 || ^24.15.0 || >=26.0.0"`. A looser floor would let
 * users install on Node 22.0–22.22.1 and hit `EBADENGINE` pointing at a
 * transitive dep instead of at our package. See #347 + #360.
 */
export const REQUIRED_NODE_FLOOR = '>=22.22.2'
