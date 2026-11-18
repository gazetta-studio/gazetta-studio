/**
 * #1186: a target without `environment` is `local` (`getEnvironment`), so
 * every docs example of a cloud-storage target sets it; a copied example
 * otherwise gets no production colours or publish confirmation.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs')
const CLOUD_STORAGE = /\b(r2Storage|s3Storage|azureBlobStorage)\(/

const indent = (line: string) => line.length - line.trimStart().length

/** Targets (object literals with a cloud `storage:`) in `ts` code blocks that set no `environment`. */
function targetsWithoutEnvironment(file: string, text: string): string[] {
  const missing: string[] = []
  for (const block of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
    const lines = block[1].split('\n')
    lines.forEach((line, i) => {
      if (!/^\s*storage:/.test(line) || !CLOUD_STORAGE.test(line)) return
      let start = i
      while (start >= 0 && !(indent(lines[start]) < indent(line) && lines[start].trimEnd().endsWith('{'))) start--
      if (start < 0) return
      let end = i
      while (end < lines.length && !(indent(lines[end]) === indent(lines[start]) && lines[end].trim().startsWith('}')))
        end++
      const target = lines.slice(start, end + 1).join('\n')
      // The pre-Cut 3 `worker:` shape in deploy.md's migration section no longer type-checks.
      if (/\bworker:/.test(target)) return
      if (!/\benvironment:/.test(target)) missing.push(`${file}: ${lines[start].trim()}`)
    })
  }
  return missing
}

describe('docs examples of cloud-storage targets (#1186)', () => {
  it('set environment on every R2, S3 or Azure target', () => {
    const missing = readdirSync(docsDir)
      .filter(f => f.endsWith('.md'))
      .flatMap(f => targetsWithoutEnvironment(f, readFileSync(resolve(docsDir, f), 'utf-8')))
    expect(missing).toEqual([])
  })
})
