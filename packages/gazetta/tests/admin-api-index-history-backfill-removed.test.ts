/**
 * Structural test pinning issue #579 — the dead history-backfill block
 * at `admin-api/index.ts` (and its `buildHistoryForSource` helper) was
 * unreachable from the route surface:
 *
 *   - When `opts.targetConfigs` has any entries, `createAdminApp`
 *     selects `registrySourceResolver`, which constructs per-request
 *     `SourceContext` via `createSourceContextFromRegistry` and wires
 *     history through the registry's `buildHistory` callback. The
 *     backfilled `source.history` is never consulted.
 *   - When `opts.targetConfigs` is empty/unset, the static-resolver
 *     path is taken, but `buildHistoryForSource` returns `undefined`
 *     in that configuration (no matching `targetConfigs[name]`), so
 *     the backfill is a no-op.
 *
 * The two configurations are mutually exclusive — there is no shape
 * under which the backfilled history reached a consumer. StrykerJS
 * mutants on the conditional and block-statement survived because the
 * branch is unreachable, not because of weak tests. The fix is
 * provable elimination by deletion.
 *
 * This test pins the deleted state — guards against accidental
 * re-introduction of the dead branch under a future refactor.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_PATH = resolve(__dirname, '../src/admin-api/index.ts')

describe('admin-api/index.ts — dead history-backfill block removed (#579)', () => {
  it('does not declare a buildHistoryForSource helper', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8')
    expect(src).not.toMatch(/\bbuildHistoryForSource\b/)
  })

  it('does not contain the dead `if (!opts.source.history)` backfill branch', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8')
    expect(src).not.toMatch(/if\s*\(\s*!\s*opts\.source\.history\s*\)/)
  })
})
