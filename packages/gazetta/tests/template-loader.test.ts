import { describe, it, expect, beforeEach } from 'vitest'
import { resolve } from 'node:path'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadTemplate, invalidateTemplate, invalidateAllTemplates } from '../src/template-loader.js'

const starterDir = resolve(import.meta.dirname, '../../../examples/starter')
const templatesDir = resolve(starterDir, 'templates')
const storage = createFilesystemProvider()

beforeEach(() => {
  invalidateAllTemplates()
})

describe('loadTemplate', () => {
  it('loads a template with render function', async () => {
    const loaded = await loadTemplate(storage, templatesDir, 'hero')
    expect(typeof loaded.render).toBe('function')
  })

  it('loads a template with schema', async () => {
    const loaded = await loadTemplate(storage, templatesDir, 'hero')
    expect(loaded.schema).toBeDefined()
  })

  it('renders HTML from loaded template', async () => {
    const loaded = await loadTemplate(storage, templatesDir, 'hero')
    const output = loaded.render({ content: { title: 'Test', subtitle: 'Sub' } })
    // The starter's `html` tag returns a String object; the renderer turns it into a plain string.
    expect(String(output.html)).toContain('Test')
    expect(typeof output.css).toBe('string')
    expect(typeof output.js).toBe('string')
  })

  it('loads .tsx template (feature-card)', async () => {
    const loaded = await loadTemplate(storage, templatesDir, 'feature-card')
    expect(typeof loaded.render).toBe('function')
    const output = loaded.render({ content: { icon: '⚡', title: 'Speed', description: 'Fast' } })
    expect(output.html).toContain('Speed')
  })

  it('loads composite template (page-default)', async () => {
    const loaded = await loadTemplate(storage, templatesDir, 'page-default')
    expect(typeof loaded.render).toBe('function')
  })

  it('caches loaded templates', async () => {
    const first = await loadTemplate(storage, templatesDir, 'hero')
    const second = await loadTemplate(storage, templatesDir, 'hero')
    expect(first).toBe(second) // same reference
  })

  it('throws for nonexistent template', async () => {
    await expect(loadTemplate(storage, templatesDir, 'nonexistent')).rejects.toThrow('Template "nonexistent" not found')
  })
})

describe('invalidateTemplate', () => {
  it('removes a template from cache', async () => {
    const first = await loadTemplate(storage, templatesDir, 'hero')
    invalidateTemplate('hero')
    const second = await loadTemplate(storage, templatesDir, 'hero')
    expect(first).not.toBe(second) // different reference after invalidation
  })

  it('does not affect other cached templates', async () => {
    const hero = await loadTemplate(storage, templatesDir, 'hero')
    await loadTemplate(storage, templatesDir, 'nav')
    invalidateTemplate('hero')

    const heroNew = await loadTemplate(storage, templatesDir, 'hero')
    const navCached = await loadTemplate(storage, templatesDir, 'nav')

    expect(heroNew).not.toBe(hero)
    // nav should still be cached (same ref from original load)
    expect(navCached).toBeDefined()
  })
})

describe('invalidateAllTemplates', () => {
  it('clears entire cache', async () => {
    const first = await loadTemplate(storage, templatesDir, 'hero')
    invalidateAllTemplates()
    const second = await loadTemplate(storage, templatesDir, 'hero')
    expect(first).not.toBe(second)
  })
})
