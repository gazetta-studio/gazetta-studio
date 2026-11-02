/** #1748: the validate report groups schema problems by template and the rest by item. */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Site } from '../src/site-loader.js'
import type { FragmentManifest, PageManifest } from '../src/types.js'
import { buildValidateReport, ValidateReportSchema } from '../src/cli/validate-report.js'
import type { Issue } from '../src/validation/types.js'

const hero = (content: Record<string, unknown>) => ({ name: 'hero', template: 'hero', content })
const page = (dir: string, components: unknown[]): PageManifest & { dir: string } =>
  ({ template: 'page-default', route: '/', dir, components }) as never

function site(): Site {
  const home = page('pages/home', [hero({ title: 'Hi' })])
  const about = page('pages/about', [hero({}), '@missing'])
  const promo = { template: 'banner', dir: 'fragments/promo', components: [hero({})] } as FragmentManifest & {
    dir: string
  }
  return {
    pages: new Map([
      ['home', home],
      ['about', about],
    ]),
    pageLocales: new Map([['home', { locales: new Map([['fr', page('pages/home', [hero({})])]]) }]]),
    fragments: new Map([['promo', promo]]),
    fragmentLocales: new Map(),
    manifest: { name: 't', targets: {} },
  } as unknown as Site
}

const schemaIssue = (itemPath: string): Issue => ({
  validator: 'schema-conformance',
  severity: 'error',
  message: 'title: Invalid input: expected string, received undefined',
  itemPath,
  contentPath: 'hero',
  field: 'title',
})

async function build(extra: Record<string, unknown> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'report-'))
  mkdirSync(join(projectRoot, 'templates/hero'), { recursive: true })
  writeFileSync(join(projectRoot, 'templates/hero/index.ts'), '')
  const { itemIssues, configIssues, projectIssues, ...rest } = extra as Record<string, unknown>
  return buildValidateReport({
    projectRoot,
    templatesDir: join(projectRoot, 'templates'),
    editingTarget: 'local',
    show: () => true,
    warnAsError: true,
    ...rest,
    lists: {
      content: [{ target: null, site: site(), itemIssues: (itemIssues as Issue[] | undefined) ?? defaultItemIssues }],
      configIssues: (configIssues as Issue[] | undefined) ?? [],
      projectIssues: (projectIssues as never[] | undefined) ?? [],
    },
  })
}

const defaultItemIssues: Issue[] = [
  schemaIssue('fragments/promo/fragment.json'),
  schemaIssue('pages/home/page.fr.json'),
  schemaIssue('pages/about/page.json'),
  {
    validator: 'referenced-fragment-exists',
    severity: 'error',
    message: 'Fragment @missing not found',
    itemPath: 'pages/about/page.json',
  },
]

describe('buildValidateReport', () => {
  it('groups two pages and a fragment under the template they break, French included', async () => {
    const report = await build()
    expect(ValidateReportSchema.parse(report)).toEqual(report)
    expect(report.ok).toBe(false)
    expect(report.templates.map(t => [t.template, t.file])).toEqual([['hero', 'templates/hero/index.ts']])
    expect(report.templates[0].items.map(i => [i.kind, i.name, i.locale])).toEqual([
      ['page', 'about', null],
      ['page', 'home', 'fr'],
      ['fragment', 'promo', null],
    ])
    expect(report.templates[0].items[0].issues[0]).toMatchObject({ component: 'hero', contentPath: 'title' })
  })

  it('puts a missing fragment under other, by item', async () => {
    const report = await build()
    expect(report.other).toEqual([
      expect.objectContaining({
        kind: 'page',
        name: 'about',
        locale: null,
        issues: [expect.objectContaining({ validator: 'referenced-fragment-exists' })],
      }),
    ])
  })

  it("lists a template's own problems with it, and config issues first under other", async () => {
    const report = await build({
      itemIssues: [],
      projectIssues: [
        {
          validator: 'template-loads',
          severity: 'error',
          message: "template banner couldn't be loaded — x",
          template: 'banner',
        },
      ],
      configIssues: [
        { validator: 'target-deploy-coverage', severity: 'info', message: 'no deploy', itemPath: 'site.config.ts' },
      ],
    })
    expect(report.templates).toEqual([
      expect.objectContaining({
        template: 'banner',
        file: null,
        items: [],
        issues: [expect.objectContaining({ validator: 'template-loads' })],
      }),
    ])
    expect(report.other[0]).toMatchObject({ kind: 'site' })
  })

  it('leaves out what --severity hides, but counts it, and passes when nothing shown fails', async () => {
    const warn: Issue = { ...schemaIssue('pages/about/page.json'), severity: 'warn' }
    const report = await build({ itemIssues: [warn], show: s => s === 'error' })
    expect(report.templates).toEqual([])
    expect(report.counts).toEqual({ error: 0, warn: 1, info: 0 })
    expect(report.ok).toBe(true)
  })
})
