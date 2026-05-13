import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The repo's runtime dependency `write-file-atomic@8` declares
// `engines: "^22.22.2 || ^24.15.0 || >=26.0.0"`. A user installing the
// gazetta-studio repo or a fresh `gazetta init` site on Node 22.0–22.22.1
// would pass our engines gate but fail write-file-atomic's, surfacing a
// confusing EBADENGINE pointing at a transitive dep. Declaring the floor
// here means the error surfaces at our package boundary with a clearer
// signal.
const REQUIRED_NODE_FLOOR = '>=22.22.2'

describe('repo engines field', () => {
  it('root package.json declares the node floor matching transitive deps', () => {
    const rootPkgPath = resolve(import.meta.dirname, '../../../package.json')
    const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'))
    expect(pkg.engines?.node).toBe(REQUIRED_NODE_FLOOR)
  })
})
