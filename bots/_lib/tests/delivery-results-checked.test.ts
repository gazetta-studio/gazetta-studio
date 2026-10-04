/**
 * #840 was a delivery result thrown away: `pushBranch(branch)` as a bare
 * statement, then "approved". TypeScript does not flag an ignored return
 * value, and the drift is a natural one (call the helper, forget the
 * result), so this scan is the guard until a lint rule can do it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BOTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === 'tests' || name === 'transcripts') return []
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

describe('delivery results are never discarded', () => {
  it('no bot calls pushBranch / runGh / savePatch as a bare statement', () => {
    const offenders = sources(BOTS).flatMap(file =>
      readFileSync(file, 'utf-8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /^\s*(pushBranch|runGh|savePatch)\(/.test(line))
        .map(({ i }) => `${relative(BOTS, file)}:${i + 1}`),
    )
    expect(offenders).toEqual([])
  })
})
