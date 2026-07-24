import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverCandidates } from '../discover.js'
import { emptySkipList } from '../skip-list.js'

/**
 * Regression test for issue #659: mutation-area-picker was proposing
 * `packages/gazetta/src/transforms/index.ts` (a pure re-export barrel)
 * to the Stryker `mutate` glob. The stryker-config.test.ts guard
 * (`no literal mutate path is a pure re-export barrel`) rejects such
 * additions at PR-review time, but the bot re-picked the same file
 * across two consecutive PRs (#646, #657) because the discovery layer
 * had no barrel filter. The fix: filter re-export barrels during
 * candidate enumeration, before scoring and before the decision tree
 * ever sees them.
 */

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'map-discover-test-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function writeSrc(relPath: string, content: string): void {
  const abs = join(repoRoot, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('discoverCandidates — barrel filter', () => {
  it('excludes pure re-export barrels from candidates', () => {
    // A barrel index.ts: re-exports only.
    writeSrc(
      'packages/gazetta/src/transforms/index.ts',
      [
        "export type { TransformAdapter } from './adapter.js'",
        "export { createSharpAdapter } from './sharp.js'",
        "export { createCloudflareAdapter } from './cloudflare.js'",
      ].join('\n'),
    )
    // A real behavioral module in the same directory.
    writeSrc(
      'packages/gazetta/src/transforms/sharp.ts',
      "export function createSharpAdapter() {\n  return { name: 'sharp' }\n}\n",
    )

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).toContain('packages/gazetta/src/transforms/sharp.ts')
    expect(result).not.toContain('packages/gazetta/src/transforms/index.ts')
  })

  it('includes an index.ts that has direct exports (not a barrel)', () => {
    // index.ts with a real export const → NOT a barrel; must be included.
    writeSrc('packages/gazetta/src/util/index.ts', "export const helper = () => 42\nexport { X } from './x.js'\n")

    const result = discoverCandidates({
      repoRoot,
      currentMutateGlob: [],
      skipList: emptySkipList(),
    })

    expect(result).toContain('packages/gazetta/src/util/index.ts')
  })
})
