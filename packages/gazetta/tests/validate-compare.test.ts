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
const run = (
  root: string,
  lists: { itemIssues?: Issue[]; configIssues?: Issue[]; projectIssues?: ProjectIssue[]; target?: string | null },
): RunIssues => ({
  content: [{ target: lists.target ?? null, site: site(root), itemIssues: lists.itemIssues ?? [] }],
  configIssues: lists.configIssues ?? [],
  projectIssues: lists.projectIssues ?? [],
})
const items = (lists: RunIssues) => lists.content.flatMap(c => c.itemIssues)
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
    expect(items(result[expected === 'new' ? 'fresh' : 'alreadyBroken'])).toHaveLength(1)
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
    expect(kept.alreadyBroken.content.flatMap(c => c.itemIssues)).toHaveLength(1)
    const moved = compareRuns(
      run('head', { itemIssues: [missing('head', 'cols')] }),
      run('base', { itemIssues: [missing('base')] }),
    )
    expect(moved.fresh.content.flatMap(c => c.itemIssues)).toHaveLength(1)
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
    expect(result.alreadyBroken.content.flatMap(c => c.itemIssues).map(i => i.message)).toEqual([
      asset('x', 'icon').message,
    ])
    expect(result.fresh.content.flatMap(c => c.itemIssues).map(i => i.message)).toEqual([asset('x', 'logo').message])
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
    expect(result.alreadyBroken.content.flatMap(c => c.itemIssues)).toHaveLength(1)
    expect(result.fresh.content.flatMap(c => c.itemIssues)).toHaveLength(0)
  })

  it('counts the same quality rule twice on a page as one problem', () => {
    const result = compareRuns(
      run('head', { itemIssues: [html('head', 12), html('head', 30), html('head', 50, 'no-dup-id')] }),
      run('base', { itemIssues: [html('base', 12)] }),
    )
    expect(result.alreadyBroken.content.flatMap(c => c.itemIssues)).toHaveLength(2)
    expect(result.fresh.content.flatMap(c => c.itemIssues).map(i => i.subject)).toEqual(['no-dup-id'])
  })

  it('counts two head issues matching one base issue as already broken', () => {
    const result = compareRuns(
      run('head', { itemIssues: [schema('head'), schema('head', { message: 'title: other wording' })] }),
      run('base', { itemIssues: [schema('base')] }),
    )
    expect(result.alreadyBroken.content.flatMap(c => c.itemIssues)).toHaveLength(2)
    expect(result.fresh.content.flatMap(c => c.itemIssues)).toHaveLength(0)
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

  it('matches the same page on the repo and on a target separately (#1754)', () => {
    const result = compareRuns(
      run('head', { itemIssues: [schema('head')], target: 'production' }),
      run('base', { itemIssues: [schema('base')] }),
    )
    expect(items(result.fresh)).toHaveLength(1)
    const onTarget = compareRuns(
      run('head', { itemIssues: [schema('head')], target: 'production' }),
      run('base', { itemIssues: [schema('base')], target: 'production' }),
    )
    expect(items(onTarget.alreadyBroken)).toHaveLength(1)
  })

  // #1756: problems that can repeat in one place carry a subject.
  it('reports a second broken link on a page as new', () => {
    const link = (root: string, href: string): Issue => ({
      validator: 'broken-links',
      severity: 'warn',
      message: `${href}: no page has this route`,
      itemPath: `${root}/pages/home/page.json`,
      subject: href,
    })
    const result = compareRuns(
      run('head', { itemIssues: [link('head', '/old'), link('head', '/new')] }),
      run('base', { itemIssues: [link('base', '/old')] }),
    )
    expect(items(result.alreadyBroken).map(i => i.subject)).toEqual(['/old'])
    expect(items(result.fresh).map(i => i.subject)).toEqual(['/new'])
  })

  it('matches two references missing alt in one array field separately', () => {
    const alt = (root: string, index: number, asset: string): Issue => ({
      validator: 'altRequired',
      severity: 'error',
      message: `Asset "${asset}" requires alt text.`,
      itemPath: `${root}/pages/home/page.json`,
      contentPath: `slides[${index}].image`,
      subject: asset,
    })
    const result = compareRuns(
      run('head', { itemIssues: [alt('head', 0, 'one'), alt('head', 1, 'two')] }),
      run('base', { itemIssues: [alt('base', 0, 'one')] }),
    )
    expect(items(result.alreadyBroken).map(i => i.subject)).toEqual(['one'])
    expect(items(result.fresh).map(i => i.subject)).toEqual(['two'])
  })

  it('reports a second config problem on one target as new', () => {
    const problem = (subject: string): Issue => ({
      validator: 'public-storage-config',
      severity: 'error',
      message: subject,
      itemPath: 'site.config.ts:targets.production',
      subject,
    })
    const result = compareRuns(
      run('head', { configIssues: [problem('history-enabled'), problem('editable')] }),
      run('base', { configIssues: [problem('history-enabled')] }),
    )
    expect(result.alreadyBroken.configIssues.map(i => i.subject)).toEqual(['history-enabled'])
    expect(result.fresh.configIssues.map(i => i.subject)).toEqual(['editable'])
  })
})

/**
 * Every validator, and whether its issues carry a subject. A validator that
 * can report two different problems in one place (item and contentPath, or
 * config path) must set one, or `--base` takes a new problem there for an
 * old one (#1756). A new validator fails this test until it's listed.
 */
const SUBJECTS: Record<string, string> = {
  'referenced-asset-exists': 'subject: the asset',
  'referenced-fragment-exists': 'subject: the fragment',
  'referenced-template-exists': 'subject: the template',
  'referenced-archived-without-alias': 'subject: the archived item',
  'schema-conformance': 'field (matched on field, not subject)',
  'html-validity': 'subject: the rule',
  accessibility: 'subject: the rule',
  'broken-links': 'subject: the link',
  altRequired: 'subject: the asset; contentPath has the array index',
  'dynamic-route-conflict': 'subject: the other page',
  'circular-alias': 'subject: cycle or chain',
  'public-storage-config': 'subject: one code per problem',
  'deploy-target-type-supported': 'subject: one code',
  'target-deploy-coverage': 'subject: one code',
  'circular-fragment': 'none: one cycle per fragment',
  'dangling-alias': 'none: one per archived item',
  'aliasOf-points-to-archived': 'none: one per archived item',
  'archive-not-supported-on-target': 'none: one per archived item',
  'orphaned-locale-file': 'none: one per language file',
  'unused-fragment': 'none: one per fragment',
}

describe('validator subjects (#1756)', () => {
  it('lists every registered validator', async () => {
    const { defaultValidatorRegistry } = await import('../src/validation/default-registry.js')
    const names = defaultValidatorRegistry()
      .all()
      .map(v => v.name)
      .sort()
    expect(names).toEqual(Object.keys(SUBJECTS).sort())
  })
})
