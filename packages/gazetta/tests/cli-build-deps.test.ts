/**
 * `gazetta build` runs in projects that install `gazetta` from npm, where only
 * its `dependencies` are installed. Packages it imports at runtime must be
 * listed there: the monorepo hoists dev and sibling dependencies, so a missing
 * one only fails outside it (#1251).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>
}

describe('gazetta build runtime dependencies', () => {
  it('lists esbuild, which bundles custom editors and fields, as a dependency', () => {
    expect(pkg.dependencies).toHaveProperty('esbuild')
  })
})
