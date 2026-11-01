/**
 * Which components a save touches: the ones its schema check parses
 * (design-agent-access.md Q49).
 */
import { describe, expect, it } from 'vitest'
import { touchedComponents } from '../src/validation/touched-components.js'

const c = (name: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name,
  template: 'hero',
  content,
  ...extra,
})
const page = (components: unknown[], content: Record<string, unknown> = {}) => ({
  template: 'page-default',
  content,
  components: components as never,
})
const paths = (before: ReturnType<typeof page> | null, after: ReturnType<typeof page>) =>
  touchedComponents(before, after).map(t => t.path)

describe('touchedComponents', () => {
  const stored = page([c('hero', { title: 'A' }), c('intro', { title: 'B' })])

  it('nothing changed: nothing touched', () => {
    expect(paths(stored, page([c('hero', { title: 'A' }), c('intro', { title: 'B' })]))).toEqual([])
  })

  it('changed content', () => {
    expect(paths(stored, page([c('hero', { title: 'A2' }), c('intro', { title: 'B' })]))).toEqual(['hero'])
  })

  it('changed template', () => {
    expect(
      paths(stored, page([c('hero', { title: 'A' }, { template: 'banner' }), c('intro', { title: 'B' })])),
    ).toEqual(['hero'])
  })

  it('a new component', () => {
    expect(paths(stored, page([c('hero', { title: 'A' }), c('intro', { title: 'B' }), c('cta', {})]))).toEqual(['cta'])
  })

  it('moving components without changing them', () => {
    expect(paths(stored, page([c('intro', { title: 'B' }), c('hero', { title: 'A' })]))).toEqual([])
  })

  it('removing a component touches nothing', () => {
    expect(paths(stored, page([c('hero', { title: 'A' })]))).toEqual([])
  })

  it("the item's own content is the path ''", () => {
    expect(paths(stored, page([c('hero', { title: 'A' }), c('intro', { title: 'B' })], { x: 1 }))).toEqual([''])
  })

  it('nested inline components, by name path', () => {
    const nested = (title: string) => page([c('cols', {}, { components: [c('left', { title })] })])
    expect(paths(nested('L'), nested('L2'))).toEqual(['cols/left'])
    expect(paths(nested('L'), nested('L'))).toEqual([])
  })

  it('a component found at another path counts as new', () => {
    const before = page([c('cols', {}, { components: [c('left', { title: 'L' })] })])
    const after = page([c('cols', {}), c('left', { title: 'L' })])
    expect(paths(before, after)).toEqual(['left'])
  })

  it('fragment references are never touched', () => {
    expect(paths(stored, page(['@header', c('hero', { title: 'A' }), c('intro', { title: 'B' })]))).toEqual([])
  })

  it('a new item touches every component', () => {
    expect(paths(null, stored)).toEqual(['', 'hero', 'intro'])
  })
})

describe('schema-conformance severities', () => {
  it('is an error at save and pre-publish, a warning in the background and the CLI', async () => {
    const { schemaConformance } = await import('../src/validation/validators/schema-conformance.js')
    expect(schemaConformance.defaultSeverity('save-delta')).toBe('error')
    expect(schemaConformance.defaultSeverity('pre-publish')).toBe('error')
    expect(schemaConformance.defaultSeverity('background')).toBe('warn')
    expect(schemaConformance.defaultSeverity('cli')).toBe('warn')
  })

  it('the background scan still warns on an invalid component', async () => {
    const { schemaConformance } = await import('../src/validation/validators/schema-conformance.js')
    const { starterTemplatesDir } = await import('./_helpers/starter.js')
    const manifest = page([c('hero', {}), c('intro', { title: 'B' })])
    const issues = await schemaConformance.validate({
      stage: 'background',
      site: { templatesDir: starterTemplatesDir } as never,
      contentRoot: undefined as never,
      storage: undefined as never,
      scope: { kind: 'background', item: { kind: 'page', name: 'home', itemPath: 'pages/home/page.json' }, manifest },
    })
    expect(issues.map(i => [i.contentPath, i.severity])).toEqual([['hero', 'warn']])
  })
})
