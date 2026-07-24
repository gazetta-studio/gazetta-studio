import { describe, expect, it } from 'vitest'
import { isReExportBarrel } from '../barrel-detector.js'

describe('isReExportBarrel', () => {
  it('is true for a file whose only exports are `export ... from ...`', () => {
    const src = [
      "export type { AssetUrlInput, CachePolicy, TransformAdapter } from './adapter.js'",
      "export { createSharpAdapter, defaultSharpAdapter } from './sharp.js'",
      "export { createCloudflareAdapter } from './cloudflare.js'",
      "export { sharpAdapter, cloudflareAdapter } from './factories.js'",
    ].join('\n')
    expect(isReExportBarrel(src)).toBe(true)
  })

  it('is true when comments + blank lines surround the re-exports', () => {
    const src = `
/**
 * Transform-adapter barrel.
 *
 * Re-exports the operator-facing factories for the gazetta/transforms subpath.
 */
export type { TransformAdapter } from './adapter.js'

// Internal factories.
export { createSharpAdapter } from './sharp.js'
`
    expect(isReExportBarrel(src)).toBe(true)
  })

  it('is true for `export *` re-exports', () => {
    const src = "export * from './helpers.js'\nexport * as util from './util.js'\n"
    expect(isReExportBarrel(src)).toBe(true)
  })

  it('is false for files with a direct `export const`', () => {
    const src = "export const answer = 42\nexport type { X } from './x.js'\n"
    expect(isReExportBarrel(src)).toBe(false)
  })

  it('is false for files with a direct `export function`', () => {
    const src = "export function greet() { return 'hi' }\nexport { Y } from './y.js'\n"
    expect(isReExportBarrel(src)).toBe(false)
  })

  it('is false for files with `export default`', () => {
    const src = "export default function main() {}\nexport type { Z } from './z.js'\n"
    expect(isReExportBarrel(src)).toBe(false)
  })

  it('is false for files with a direct `export class`', () => {
    const src = "export class MyClass {}\n"
    expect(isReExportBarrel(src)).toBe(false)
  })

  it('is false for files with a direct `export async function`', () => {
    const src = "export async function doStuff() {}\n"
    expect(isReExportBarrel(src)).toBe(false)
  })

  it('is false for files with zero export statements (nothing to re-export)', () => {
    const src = "// This file has no exports.\nconst x = 1\n"
    expect(isReExportBarrel(src)).toBe(false)
  })

  it('is false for empty files', () => {
    expect(isReExportBarrel('')).toBe(false)
    expect(isReExportBarrel('\n\n\n')).toBe(false)
  })
})
