/** #1748: GitHub output — a job summary per template and an annotation on its entry file. */
import { describe, expect, it } from 'vitest'
import { cell, escapeData, escapeProperty, renderGithub } from '../src/cli/validate-render.js'
import type { ValidateReport } from '../src/cli/validate-report.js'

const issue = (message: string, severity: 'error' | 'warn' = 'error') => ({
  validator: 'schema-conformance',
  severity,
  message,
  component: 'hero',
  contentPath: 'title',
})

const failing: ValidateReport = {
  ok: false,
  counts: { error: 3, warn: 0, info: 0 },
  templates: [
    {
      template: 'hero',
      file: 'templates/hero/index.ts',
      issues: [],
      items: [
        { kind: 'page', name: 'about', locale: null, issues: [issue('title: Required')] },
        { kind: 'page', name: 'home', locale: 'fr', issues: [issue('title: a|b')] },
      ],
    },
  ],
  other: [
    {
      kind: 'page',
      name: 'about',
      locale: null,
      issues: [
        {
          ...issue('Fragment @missing not found'),
          validator: 'referenced-fragment-exists',
          component: null,
          contentPath: null,
        },
      ],
    },
  ],
}

describe('renderGithub', () => {
  it('writes a table per template and the other problems', () => {
    const { summary } = renderGithub(failing)
    expect(summary).toContain('### `hero` (`templates/hero/index.ts`)')
    expect(summary).toContain('| Item | Language | Field | Message |')
    expect(summary).toContain('| pages/about | default | hero › title | title: Required |')
    expect(summary).toContain('| pages/home | fr | hero › title | title: a\\|b |')
    expect(summary).toContain('### Other problems')
    expect(summary).toContain('Fragment @missing not found')
  })

  it("annotates the template's entry file once, naming the items", () => {
    const { annotations } = renderGithub(failing)
    expect(annotations).toEqual([
      "::error file=templates/hero/index.ts,title=hero doesn't fit 2 items::pages/about, pages/home (fr)",
    ])
  })

  it('is one line and no annotations when the check passes', () => {
    expect(renderGithub({ ok: true, counts: { error: 0, warn: 0, info: 0 }, templates: [], other: [] })).toEqual({
      summary: '**Template check passed.**\n',
      annotations: [],
    })
  })

  it('escapes workflow command data and properties', () => {
    expect(escapeData('50%\r\nnext')).toBe('50%25%0D%0Anext')
    expect(escapeProperty('a:b,c%')).toBe('a%3Ab%2Cc%25')
  })

  it('escapes a backslash before a pipe in a table cell (CodeQL on #1749)', () => {
    expect(cell('a\\|b\nc')).toBe('a\\\\\\|b c')
  })

  it('puts already-broken problems in a collapsed block, without annotating them (#1750)', () => {
    const alreadyBroken = { templates: failing.templates, other: [] }
    const passing: ValidateReport = { ok: true, counts: { error: 0, warn: 0, info: 0 }, templates: [], other: [], alreadyBroken }
    const { summary, annotations } = renderGithub(passing)
    expect(summary).toMatch(/^\*\*Template check passed\.\*\*/)
    expect(summary).toContain('<details><summary>Already broken (not caused by this change)</summary>')
    expect(summary).toContain('#### `hero`')
    expect(summary).toContain('| pages/about | default | hero › title | title: Required |')
    expect(annotations).toEqual([])
  })
})

