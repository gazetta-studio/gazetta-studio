/**
 * Unit tests for the pure projections + table renderer used by
 * `gazetta assets list` and `gazetta assets info`. No I/O —
 * the runner orchestrates; this module is pure transformation.
 */
import { describe, expect, it } from 'vitest'
import { LIST_COLUMNS, projectInfo, projectListRow, renderListTable } from '../src/cli/assets-display.js'
import type { AssetManifest, AssetSummary } from '../src/schema/types.js'

function summary(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    name: 'hero',
    kind: 'embedded',
    mime: 'image/jpeg',
    size: 245678,
    hash: 'a3b2c1d4',
    width: 1920,
    height: 1080,
    alt: 'Mountain sunset at dusk',
    uploadedAt: '2026-04-22T14:23:05Z',
    overrideLocales: [],
    overrideThemes: [],
    ...overrides,
  }
}

describe('projectListRow', () => {
  it('projects every field for a typical image asset', () => {
    const row = projectListRow(summary())
    expect(row).toEqual({
      name: 'hero',
      kind: 'embedded',
      size: '239.9 KB',
      dims: '1920×1080',
      alt: 'Mountain sunset at dusk',
      locales: '—',
      uploaded: '2026-04-22',
    })
  })

  it("renders dimensions as '—' when missing", () => {
    const row = projectListRow(summary({ width: null, height: null }))
    expect(row.dims).toBe('—')
  })

  it("renders unset alt as '(unset)'", () => {
    const row = projectListRow(summary({ alt: null }))
    expect(row.alt).toBe('(unset)')
  })

  it("renders empty-string alt as '(decorative)'", () => {
    const row = projectListRow(summary({ alt: '' }))
    expect(row.alt).toBe('(decorative)')
  })

  it('truncates long alt to keep tabular rows readable', () => {
    const row = projectListRow(summary({ alt: 'A'.repeat(50) }))
    expect(row.alt.length).toBeLessThanOrEqual(30)
    expect(row.alt.endsWith('...')).toBe(true)
  })

  it('joins override locales with comma', () => {
    const row = projectListRow(summary({ overrideLocales: ['fr', 'ar'] }))
    expect(row.locales).toBe('fr,ar')
  })

  it('shows uploaded as ISO date only (no time)', () => {
    const row = projectListRow(summary({ uploadedAt: '2026-04-22T14:23:05Z' }))
    expect(row.uploaded).toBe('2026-04-22')
  })
})

describe('renderListTable', () => {
  it('returns empty array on empty input', () => {
    expect(renderListTable([])).toEqual([])
  })

  it('emits a header row + one row per input', () => {
    const rows = [projectListRow(summary({ name: 'a' })), projectListRow(summary({ name: 'b' }))]
    const lines = renderListTable(rows)
    expect(lines).toHaveLength(3) // header + 2 rows
    expect(lines[0]).toContain('NAME')
    expect(lines[0]).toContain('KIND')
    expect(lines[1]).toContain('a')
    expect(lines[2]).toContain('b')
  })

  it('left-pads `start`-aligned columns and right-pads `end`-aligned', () => {
    const rows = [
      projectListRow(summary({ name: 'short' })),
      projectListRow(summary({ name: 'a-very-long-name-here' })),
    ]
    const lines = renderListTable(rows)
    // Both rows + header start at the same column boundary (NAME col is left-aligned).
    const namePosHeader = lines[0]!.indexOf('NAME')
    const namePosRow1 = lines[1]!.indexOf('short')
    expect(namePosHeader).toBe(namePosRow1)
  })

  it('exposes the columns in display order', () => {
    expect(LIST_COLUMNS.map(c => c.key)).toEqual(['name', 'kind', 'size', 'dims', 'alt', 'locales', 'uploaded'])
  })
})

function manifest(overrides: Partial<AssetManifest> = {}): AssetManifest {
  return {
    version: 1,
    name: 'hero',
    kind: 'embedded',
    source: 'internal',
    mime: 'image/jpeg',
    size: 245678,
    hash: 'a3b2c1d4',
    width: 1920,
    height: 1080,
    variants: [],
    alt: 'Mountain sunset',
    uploadedAt: '2026-04-22T14:23:05Z',
    uploadedBy: '',
    ...overrides,
  }
}

describe('projectInfo', () => {
  it('produces the metadata section in fixed order', () => {
    const out = projectInfo({ manifest: manifest(), overrideSlices: [], references: [] })
    const labels = out.metadata.rows.map(r => r.label)
    expect(labels).toEqual(['Kind', 'Type', 'Hash', 'Size', 'Dimensions', 'Alt', 'Uploaded'])
  })

  it('includes Focal row only when focalPoint is set', () => {
    const without = projectInfo({ manifest: manifest(), overrideSlices: [], references: [] })
    expect(without.metadata.rows.find(r => r.label === 'Focal')).toBeUndefined()

    const withFp = projectInfo({
      manifest: manifest({ focalPoint: { x: 0.3, y: 0.7 } }),
      overrideSlices: [],
      references: [],
    })
    expect(withFp.metadata.rows.find(r => r.label === 'Focal')?.value).toBe('30% × 70%')
  })

  it('omits Dimensions row when width/height absent', () => {
    const out = projectInfo({
      manifest: manifest({ width: null, height: null }),
      overrideSlices: [],
      references: [],
    })
    expect(out.metadata.rows.find(r => r.label === 'Dimensions')).toBeUndefined()
  })

  it('appends "by <author>" to Uploaded when uploadedBy is set', () => {
    const out = projectInfo({
      manifest: manifest({ uploadedBy: 'alice' }),
      overrideSlices: [],
      references: [],
    })
    expect(out.metadata.rows.find(r => r.label === 'Uploaded')?.value).toContain('by alice')
  })

  it('projects variants with width / size / path', () => {
    const out = projectInfo({
      manifest: manifest({
        variants: [
          { width: 400, path: 'assets/hero-a3b2c1d4-400w.jpg', size: 24567 },
          { width: 800, path: 'assets/hero-a3b2c1d4-800w.jpg', size: 68234 },
        ],
      }),
      overrideSlices: [],
      references: [],
    })
    expect(out.variants).toEqual([
      { width: '400w', size: '24.0 KB', path: 'assets/hero-a3b2c1d4-400w.jpg' },
      { width: '800w', size: '66.6 KB', path: 'assets/hero-a3b2c1d4-800w.jpg' },
    ])
  })

  it('renders override slice selectors', () => {
    const out = projectInfo({
      manifest: manifest(),
      overrideSlices: [
        {
          selector: new Map([['locale', 'fr']]),
          bytes: 'assets/hero-d5e6f7a8.fr.jpg',
        },
        {
          selector: new Map([
            ['locale', 'fr'],
            ['theme', 'dark'],
          ]),
          bytes: null,
        },
      ],
      references: [],
    })
    expect(out.overrides).toEqual([
      { selector: 'locale=fr', bytes: 'bytes' },
      { selector: 'locale=fr theme=dark', bytes: 'metadata only' },
    ])
  })

  it('renders references as folder/name with optional locale suffix', () => {
    const out = projectInfo({
      manifest: manifest(),
      overrideSlices: [],
      references: [
        { source: 'page', name: 'home' },
        { source: 'fragment', name: 'header', locale: 'fr' },
      ],
    })
    expect(out.references).toEqual([{ path: 'pages/home' }, { path: 'fragments/header:fr' }])
  })
})
