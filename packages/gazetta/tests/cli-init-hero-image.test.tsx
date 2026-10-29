// @vitest-environment jsdom
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { z } from 'zod'
import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { loadTemplate } from '../src/template-loader.js'
import { DefaultEditorForm } from '../src/editor/mount.js'
import { tempDir } from './_helpers/temp.js'

let directory: string
let hero: Awaited<ReturnType<typeof loadTemplate>>
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeAll(async () => {
  const parent = tempDir('init-hero-image')
  await mkdir(parent, { recursive: true })
  directory = await mkdtemp(join(parent, 'site-'))
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n')
  await chmod(join(bin, 'npm'), 0o755)
  execFileSync(
    process.execPath,
    [resolve(import.meta.dirname, '../dist/cli/index.js'), 'init', join(directory, 'site')],
    { env: { ...process.env, CI: 'true', PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe', timeout: 30000 },
  )
  hero = await loadTemplate(undefined, join(directory, 'site/templates'), 'hero')
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
it('loads index.ts and keeps an optional image asset field in the admin schema', async () => {
  const json = z.toJSONSchema(hero.schema) as any
  expect(json.properties.image.assetOptions).toEqual({ accept: ['image'] })
  expect(json.required).not.toContain('image')
  expect(hero.schema.safeParse({ title: 'Hello', subtitle: 'World' }).success).toBe(true)
  const page = JSON.parse(await readFile(join(directory, 'site/sites/main/targets/local/pages/home/page.json'), 'utf8'))
  expect(page.components.find((c: any) => c.name === 'hero').content).not.toHaveProperty('image')
})
it('renders the resolved image attributes when present and keeps the image-free hero valid', async () => {
  const plain = await hero.render({ content: { title: 'Hello', subtitle: 'World' } } as any)
  expect(plain.html).toContain('<h1>Hello</h1>')
  expect(plain.html).toContain('<p>World</p>')
  expect(plain.html).not.toContain('<img')
  expect(plain.html).toBe('<section class="hero">\n  <h1>Hello</h1>\n  <p>World</p>\n</section>')
  const withImage = await hero.render({
    content: {
      title: 'Hello',
      subtitle: 'World',
      image: {
        url: '/assets/hero.png',
        alt: 'A hill',
        srcset: '/assets/small.png 320w, /assets/hero.png 640w',
        width: 640,
        height: 480,
      },
    },
  } as any)
  const container = document.createElement('div')
  container.innerHTML = withImage.html
  const img = container.querySelector('img')!
  expect(img.getAttribute('src')).toBe('/assets/hero.png')
  expect(img.getAttribute('alt')).toBe('A hill')
  expect(img.getAttribute('srcset')).toContain('320w')
  expect(img.getAttribute('width')).toBe('640')
  expect(img.getAttribute('height')).toBe('480')
})
it('shows a picker for the init hero even when no optional image is selected', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  )
  try {
    act(() => {
      root.render(
        React.createElement(DefaultEditorForm, {
          schema: z.toJSONSchema(hero.schema) as any,
          content: { title: 'Hello' },
          onChange: () => {},
          onPickAsset: async () => null,
        }),
      )
    })
    expect(container.querySelector('[data-testid="asset-widget-pick"]')).not.toBeNull()
    expect(container.querySelector('input[id$="__asset"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
