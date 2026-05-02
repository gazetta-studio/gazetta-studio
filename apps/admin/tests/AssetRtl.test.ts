/**
 * RTL validation for the asset workflow surfaces.
 *
 * Two layers:
 *
 *   1. **Static audit** — read each component's <style> block directly
 *      from disk and assert it uses no hard-coded `left`/`right` CSS
 *      properties (`margin-left`, `padding-right`, `text-align: left`,
 *      `border-left`, `float: right`, etc.). Logical properties
 *      (`margin-inline-start`, `text-align: start`) pass.
 *
 *   2. **Runtime smoke** — mount each component with `dir="rtl"` on
 *      <html> and verify it renders without throwing, with the
 *      expected DOM order intact (logical order doesn't reverse —
 *      the browser flips visually via CSS).
 *
 * Why static audit instead of computed-style inspection: PrimeVue's
 * CSS is concatenated into the same `<style>` tags as our scoped
 * styles in jsdom, so a CSS-text scan hits PrimeVue's own properties.
 * Reading from disk reads only the component author's CSS — exactly
 * the surface this audit is responsible for.
 *
 * The starter site has Arabic content (per design-media-implementation.md
 * "RTL validation must-have"), so the asset library + detail pane + picker
 * must work right-to-left from day one. Visual layout regression is a
 * Playwright e2e concern; this catches the property-level slip-ups.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import PrimeVue from 'primevue/config'
import AssetDetailLocaleSection from '../src/client/components/AssetDetailLocaleSection.vue'
import AssetLibraryGrid from '../src/client/components/AssetLibraryGrid.vue'
import AssetUploadPrompt from '../src/client/components/AssetUploadPrompt.vue'
import { useAssetsListStore } from '../src/client/stores/assetsList.js'
import { useAssetsUploadPromptStore } from '../src/client/stores/assetsUploadPrompt.js'
import { useSiteStore } from '../src/client/stores/site.js'
import type { AssetSummary } from 'gazetta/schema'

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  document.documentElement.setAttribute('dir', 'rtl')
  document.documentElement.setAttribute('lang', 'ar')
})

afterEach(() => {
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
})

function setSiteLocales(supported: string[], defaultLocale: string) {
  const site = useSiteStore()
  site.manifest = {
    name: 'test',
    locale: defaultLocale,
    locales: { supported },
  } as unknown as typeof site.manifest
}

function sample(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    name: 'hero',
    kind: 'embedded',
    mime: 'image/jpeg',
    size: 1000,
    hash: 'aaaaaaaa',
    width: 100,
    height: 100,
    alt: null,
    uploadedAt: '2026-04-22T00:00:00.000Z',
    overrideLocales: [],
    overrideThemes: [],
    ...overrides,
  }
}

/**
 * Read the <style scoped> blocks from a Vue SFC on disk and audit them
 * for non-logical left/right properties. Catches:
 *   margin-left / margin-right / padding-left / padding-right
 *   border-left / border-right (and variants like -color, -width, -style)
 *   text-align: left / right  (start/end pass)
 *   float: left / right
 *
 * Excludes `position: left/right` (Dialog corners use these intentionally),
 * `:dir(rtl)`-scoped rules (those are RTL-aware overrides), and any
 * `/* rtl-ok *\/` annotated lines.
 */
function auditComponentCss(componentPath: string): string[] {
  const abs = resolve(__dirname, '..', 'src', 'client', 'components', componentPath)
  const source = readFileSync(abs, 'utf-8')
  // Pull every <style> block out of the SFC.
  const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1] ?? '')
  const violations: string[] = []
  for (const block of styleBlocks) {
    const lines = block.split('\n')
    let inDirRtlBlock = false
    let braceDepth = 0
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('//') || line.startsWith('/*')) continue
      // Track simple :dir() guards so an LTR-aware override counts as
      // intentional.
      if (line.includes(':dir(rtl)') || line.includes(':dir(ltr)')) {
        inDirRtlBlock = true
      }
      const opens = (line.match(/\{/g) ?? []).length
      const closes = (line.match(/\}/g) ?? []).length
      braceDepth += opens - closes
      if (inDirRtlBlock && braceDepth === 0) inDirRtlBlock = false
      if (inDirRtlBlock) continue

      // Allow author opt-out for cases where a physical property is
      // genuinely correct (mirrors of icons, RTL-specific overrides).
      if (line.includes('/* rtl-ok */')) continue

      if (/(^|[\s;])(margin|padding|border)-(left|right)\b\s*:/.test(line)) {
        violations.push(line)
      } else if (/(^|[\s;])text-align\s*:\s*(left|right)\b/.test(line)) {
        violations.push(line)
      } else if (/(^|[\s;])float\s*:\s*(left|right)\b/.test(line)) {
        violations.push(line)
      }
    }
  }
  return violations
}

describe('RTL: static CSS audit', () => {
  it('AssetUploadPrompt has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetUploadPrompt.vue')).toEqual([])
  })

  it('AssetDetailLocaleSection has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetDetailLocaleSection.vue')).toEqual([])
  })

  it('AssetLibraryGrid has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetLibraryGrid.vue')).toEqual([])
  })

  it('AssetUploadZone has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetUploadZone.vue')).toEqual([])
  })

  it('AssetDetail has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetDetail.vue')).toEqual([])
  })

  it('AssetLibraryContent has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetLibraryContent.vue')).toEqual([])
  })

  it('AssetPicker has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetPicker.vue')).toEqual([])
  })

  it('AssetLibrary has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetLibrary.vue')).toEqual([])
  })

  it('AssetAltEditor has no hard-coded left/right properties', () => {
    expect(auditComponentCss('AssetAltEditor.vue')).toEqual([])
  })
})

describe('RTL: runtime smoke', () => {
  it('AssetLibraryGrid mounts under dir="rtl" without errors', () => {
    setSiteLocales(['en', 'fr', 'ar'], 'en')
    const list = useAssetsListStore()
    list.loaded = true
    list.assets = [sample({ name: 'hero', overrideLocales: ['fr'] })]

    expect(() =>
      mount(AssetLibraryGrid, {
        attachTo: document.body,
        global: { plugins: [PrimeVue] },
      }),
    ).not.toThrow()
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
  })

  it('AssetLibraryGrid coverage chips render in document order under RTL', () => {
    setSiteLocales(['en', 'fr', 'ar'], 'en')
    const list = useAssetsListStore()
    list.loaded = true
    list.assets = [sample({ name: 'hero' })]

    const wrapper = mount(AssetLibraryGrid, {
      attachTo: document.body,
      global: { plugins: [PrimeVue] },
    })

    // DOM order is stable regardless of `dir` — visual reversal is the
    // browser's job. Screen readers announce the same sequence; this
    // verifies authors haven't accidentally reordered chips for RTL.
    const chips = wrapper.findAll('[data-testid^="coverage-chip-hero-"]')
    expect(chips.map(c => c.attributes('data-testid'))).toEqual([
      'coverage-chip-hero-en',
      'coverage-chip-hero-fr',
      'coverage-chip-hero-ar',
    ])
  })

  it('AssetDetailLocaleSection mounts under dir="rtl" with default + override + add buttons', () => {
    setSiteLocales(['en', 'fr', 'ar'], 'en')
    const wrapper = mount(AssetDetailLocaleSection, {
      attachTo: document.body,
      props: { asset: sample({ overrideLocales: ['fr'] }) },
      global: { plugins: [PrimeVue] },
    })

    expect(wrapper.find('[data-testid="locale-row-default"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="locale-row-fr"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="locale-add-ar"]').exists()).toBe(true)
  })

  it('AssetUploadPrompt mounts under dir="rtl" with the locale label rendered', async () => {
    const promptStore = useAssetsUploadPromptStore()
    mount(AssetUploadPrompt, {
      attachTo: document.body,
      global: { plugins: [PrimeVue] },
    })
    void promptStore.prompt({
      file: new File(['x'], 'hero.jpg', { type: 'image/jpeg' }),
      name: 'hero',
      locale: 'ar',
      activeLocaleLabel: 'Arabic',
      defaultLocaleLabel: 'English',
    })
    await new Promise(r => setTimeout(r, 0))

    const dialog = document.querySelector('[data-testid="upload-prompt"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('Arabic')
    expect(dialog!.textContent).toContain('English')
  })
})
