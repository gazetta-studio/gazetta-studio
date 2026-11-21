/**
 * #1261: `docs/auth.md` documents `admin.auth.roleMapping`, and its
 * example is a valid `admin.auth` block.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthConfigSchema } from '../src/auth/config.js'

const authDoc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/auth.md'), 'utf-8')

function section(heading: string): string {
  const start = authDoc.indexOf(`### ${heading}\n`)
  expect(start, `docs/auth.md has no "### ${heading}" section`).toBeGreaterThanOrEqual(0)
  const rest = authDoc.slice(start + heading.length + 5)
  const end = rest.search(/^#{2,3} /m)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('docs/auth.md group → role mapping (#1261)', () => {
  const text = section('Group-claim → role mapping')

  it('describes roleMapping instead of calling it a follow-up', () => {
    expect(text).not.toMatch(/follow-up|Future work/i)
    for (const field of ['roleMapping', '`claim`', '`map`', '`defaultRole`']) expect(text).toContain(field)
  })

  it('has an example that is a valid admin.auth block with a roleMapping', () => {
    const block = text.match(/```ts\n([\s\S]*?)```/)?.[1]
    expect(block, 'the section has a ts example').toBeDefined()
    // The example is an `admin: { auth: { … } }` fragment of literals.
    const example = new Function(`return ({ ${block} })`)() as { admin: { auth: unknown } }
    const parsed = AuthConfigSchema.parse(example.admin.auth)
    expect('roleMapping' in parsed && parsed.roleMapping).toBeTruthy()
  })
})
