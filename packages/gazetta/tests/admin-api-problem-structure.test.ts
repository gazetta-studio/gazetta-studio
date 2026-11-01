/**
 * Every admin-API error goes through `problem()` / `problemFrom()`
 * (design-agent-access.md Q45). A route that answers `c.json(..., 4xx)` or
 * `c.json({ error })` skips the problem+json shape, and new routes are
 * added without thinking about it, so this is checked on the source
 * (team rule 41: drift-prone through normal edits).
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = join(import.meta.dirname, '..', 'src')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => join(e.parentPath, e.name))
}

/** The argument text of every `c.json(...)` / `c.text(...)` call. */
function responseCalls(text: string): string[] {
  const calls: string[] = []
  const re = /\bc\.(json|text)\(/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
    }
    calls.push(text.slice(start, i - 1))
  }
  return calls
}

const ERROR_STATUS = /,\s*(4\d\d|5\d\d)\s*(as [A-Za-z]+)?\s*,?\s*$/

describe('admin-API errors use the problem helper', async () => {
  const files = [...(await sourceFiles(join(src, 'admin-api'))), join(src, 'alt', 'route-handler.ts')]

  it.each(files.map(f => [f.slice(src.length + 1), f]))(
    '%s answers no error with c.json or c.text',
    async (_rel, file) => {
      const offending = responseCalls(await readFile(file, 'utf8')).filter(
        call => ERROR_STATUS.test(call) || /^\s*\{\s*error\b/.test(call),
      )
      expect(offending).toEqual([])
    },
  )
})
