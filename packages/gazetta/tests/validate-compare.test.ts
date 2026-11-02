/** #1750: --base matches head problems with the base commit's on everything but the message. */
import { describe, expect, it } from 'vitest'
import { compareRuns } from '../src/cli/validate-compare.js'
import type { RunIssues } from '../src/cli/validate-run.js'
import type { ProjectIssue } from '../src/cli/project-checks.js'
import type { Site } from '../src/site-loader.js'
import type { Issue } from '../src/validation/types.js'

// Two sites with the same items in different folders, as head and base are.
function site(root: string): Site {
  const page = { template: 'page-default', route: '/', dir: `${root}/pages/home`, components: [] }
  return {
    pages: new Map([['home', page]]),
    pageLocales: new Map([['home', { locales: new Map([['fr', page]]) }]]),
    fragments: new Map(),
    fragmentLocales: new Map(),
    manifest: { name: 't', targets: {} },
  } as unknown as Site
}
const run = (root: string, lists: Partial<Omit<RunIssues, 'site'>>): RunIssues => ({
  site: site(root),
  itemIssues: [],
  configIssues: [],
  projectIssues: [],
  ...lists,
})
const schema = (root: string, over: Partial<Issue> = {}): Issue => ({
  validator: 'schema-conformance',
  severity: 'error',
  message: 'title: Invalid input',
  itemPath: `${root}/pages/home/page.json`,
  contentPath: 'hero',
  field: 'title',
  ...over,
})

describe('compareRuns', () => {
  it.each([
    ['the same schema problem, message reworded', {}, { message: 'title: A title is required' }, 'already'],
    ['another field', {}, { field: 'subtitle' }, 'new'],
    ['another component', {}, { contentPath: 'banner' }, 'new'],
    ['another language', {}, { itemPath: 'head/pages/home/page.fr.json' }, 'new'],
    ['another validator', {}, { validator: 'referenced-template-exists' }, 'new'],
  ] as const)('schema issue: %s → %s', (_, baseOver, headOver, expected) => {
    const result = compareRuns(
      run('head', { itemIssues: [schema('head', headOver)] }),
      run('base', { itemIssues: [schema('base', baseOver)] }),
    )
    expect(result[expected === 'new' ? 'fresh' : 'alreadyBroken'].itemIssues).toHaveLength(1)
  })

  it('matches other item issues by validator, item and contentPath', () => {
    const missing = (root: string, contentPath?: string): Issue => ({
      validator: 'referenced-fragment-exists',
      severity: 'error',
      message: '@old not found',
      itemPath: `${root}/pages/home/page.json`,
      contentPath,
    })
    const kept = compareRuns(
      run('head', { itemIssues: [missing('head')] }),
      run('base', { itemIssues: [missing('base')] }),
    )
    expect(kept.alreadyBroken.itemIssues).toHaveLength(1)
    const moved = compareRuns(
      run('head', { itemIssues: [missing('head', 'cols')] }),
      run('base', { itemIssues: [missing('base')] }),
    )
    expect(moved.fresh.itemIssues).toHaveLength(1)
  })

  it('tells two missing assets in one component apart (Seer on #1751)', () => {
    const asset = (root: string, name: string): Issue => ({
      validator: 'referenced-asset-exists',
      severity: 'error',
      message: `Asset "${name}" referenced but not found in the asset library.`,
      itemPath: `${root}/pages/home/page.json`,
      contentPath: 'hero',
      subject: name,
    })
    const result = compareRuns(
      run('head', { itemIssues: [asset('head', 'icon'), asset('head', 'logo')] }),
      run('base', { itemIssues: [asset('base', 'icon')] }),
    )
    expect(result.alreadyBroken.itemIssues.map(i => i.message)).toEqual([asset('x', 'icon').message])
    expect(result.fresh.itemIssues.map(i => i.message)).toEqual([asset('x', 'logo').message])
  })

  const html = (root: string, line: number, rule = 'attr-quotes'): Issue => ({
    validator: 'html-validity',
    severity: 'warn',
    message: `${rule}: Attribute value must be quoted (line ${line}, col 3)`,
    itemPath: `${root}/pages/home/page.json`,
    subject: rule,
  })

  it('keeps an html-validity warning already broken when its line moves', () => {
    const result = compareRuns(
      run('head', { itemIssues: [html('head', 40)] }),
      run('base', { itemIssues: [html('base', 12)] }),
    )
    expect(result.alreadyBroken.itemIssues).toHaveLength(1)
    expect(result.fresh.itemIssues).toHaveLength(0)
  })

  it('counts the same quality rule twice on a page as one problem', () => {
    const result = compareRuns(
      run('head', { itemIssues: [html('head', 12), html('head', 30), html('head', 50, 'no-dup-id')] }),
      run('base', { itemIssues: [html('base', 12)] }),
    )
    expect(result.alreadyBroken.itemIssues).toHaveLength(2)
    expect(result.fresh.itemIssues.map(i => i.subject)).toEqual(['no-dup-id'])
  })

  it('counts two head issues matching one base issue as already broken', () => {
    const result = compareRuns(
      run('head', { itemIssues: [schema('head'), schema('head', { message: 'title: other wording' })] }),
      run('base', { itemIssues: [schema('base')] }),
    )
    expect(result.alreadyBroken.itemIssues).toHaveLength(2)
    expect(result.fresh.itemIssues).toHaveLength(0)
  })

  it('matches config issues by validator and config path', () => {
    const config = (path: string, message: string): Issue => ({
      validator: 'target-deploy-coverage',
      severity: 'info',
      message,
      itemPath: path,
    })
    const result = compareRuns(
      run('head', {
        configIssues: [config('site.config.ts:targets.production', 'a'), config('site.config.ts:targets.staging', 'b')],
      }),
      run('base', { configIssues: [config('site.config.ts:targets.production', 'reworded')] }),
    )
    expect(result.alreadyBroken.configIssues.map(i => i.itemPath)).toEqual(['site.config.ts:targets.production'])
    expect(result.fresh.configIssues.map(i => i.itemPath)).toEqual(['site.config.ts:targets.staging'])
  })

  it('matches project issues by validator, template or file, and field', () => {
    const field = (prop: string): ProjectIssue => ({
      validator: 'custom-field-exists',
      severity: 'error',
      message: prop,
      template: 'hero',
      field: prop,
    })
    const result = compareRuns(
      run('head', { projectIssues: [field('color'), field('icon')] }),
      run('base', { projectIssues: [field('color')] }),
    )
    expect(result.alreadyBroken.projectIssues.map(i => i.field)).toEqual(['color'])
    expect(result.fresh.projectIssues.map(i => i.field)).toEqual(['icon'])
  })
})
