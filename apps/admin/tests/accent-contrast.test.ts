/**
 * --color-accent marks state: the preview toolbar's active device button and
 * the selection bar in SiteTree / ComponentTree. A state indicator needs at
 * least 3:1 against what it sits on (WCAG 2.1 1.4.11); in light mode the old
 * value (#a78bfa) gave about 2.7:1 on the white toolbar (#1614).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '..', 'src', 'client', 'assets', 'tokens.css'), 'utf8')

/** The declarations of every `selector { … }` block in tokens.css, merged in file order. */
function tokens(selector: ':root' | '.dark'): Record<string, string> {
  const found: Record<string, string> = {}
  const block = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g')
  for (const [, body] of css.matchAll(block)) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found[name] = value.trim()
  }
  return found
}

const light = tokens(':root')
const dark = { ...light, ...tokens('.dark') }

type Rgb = [number, number, number]
const rgb = (hex: string): Rgb => {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i)
  return [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb
}
const luminance = ([r, g, b]: Rgb) => {
  const [lr, lg, lb] = [r, g, b].map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** `percent`% of `top` over `bottom`, as `color-mix(in srgb, top percent%, transparent)` paints it. */
const over = (top: Rgb, bottom: Rgb, percent: number): Rgb =>
  top.map((v, i) => Math.round((v * percent) / 100 + bottom[i] * (1 - percent / 100))) as Rgb

describe('--color-accent contrast (#1614)', () => {
  for (const [name, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`is at least 3:1 on the toolbar and the selected-row backgrounds in ${name} mode`, () => {
      const accent = rgb(theme['--color-accent'])
      const bg = rgb(theme['--color-bg'])
      expect(contrast(accent, bg)).toBeGreaterThanOrEqual(3)
      // SiteTree and ComponentTree mix the accent into the row at 10% (root) and 15%.
      for (const percent of [10, 15]) {
        expect(contrast(accent, over(accent, bg, percent))).toBeGreaterThanOrEqual(3)
      }
      expect(contrast(accent, rgb(theme['--color-hover-bg']))).toBeGreaterThanOrEqual(3)
    })
  }

  it('keeps the dark value, which already passed', () => {
    expect(dark['--color-accent']).toBe('#a78bfa')
  })
})
