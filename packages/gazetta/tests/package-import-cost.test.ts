/**
 * Every template imports `html` from `gazetta`, and the template scan loads
 * each template in its own worker, so importing the package must not load
 * dependencies only some features use. Runs against the built package,
 * which is what templates resolve `gazetta` to.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const distIndex = join(import.meta.dirname, '..', 'dist', 'index.js')

/** Package names under node_modules that Node loads while importing `entry`. */
function packagesLoadedBy(entry: string): Set<string> {
  // The hooks run on their own thread; a buffered stderr write there can be
  // lost when the process exits (about 1 in 10 runs on Node 26), so write
  // synchronously.
  const hooks = `import { writeSync } from 'node:fs'
  export async function load(url, context, next) {
    const m = url.match(/node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//)
    if (m) writeSync(2, 'PKG ' + m[1] + '\\n')
    return next(url, context)
  }`
  const register = `import { register } from 'node:module'
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hooks)}))`
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(register)}`,
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`importing ${entry} failed:\n${result.stderr}`)
  return new Set([...result.stderr.matchAll(/^PKG (.+)$/gm)].map(m => m[1]))
}

describe.skipIf(!existsSync(distIndex))('importing gazetta', () => {
  let loaded: Set<string>
  beforeAll(() => {
    loaded = packagesLoadedBy(distIndex)
  })

  it('reports the packages it loads', () => {
    // Guards the check itself: an import that loads nothing would pass every case below.
    expect(loaded.has('zod')).toBe(true)
  })

  it.each(['isomorphic-dompurify', 'jsdom', 'openai', '@anthropic-ai/sdk'])('does not load %s', pkg => {
    expect(loaded.has(pkg)).toBe(false)
  })
})
