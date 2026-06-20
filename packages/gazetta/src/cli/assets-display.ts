/**
 * Pure display projections + formatters for `gazetta assets list`
 * and `gazetta assets info`.
 *
 * Why a separate module: the runner (`assets-cli.ts`) does I/O and
 * writes to a sink. The projection logic — "given an asset, what
 * does its row look like in the table" — is testable on its own
 * with no I/O, no `console`, no fixtures beyond a manifest object.
 *
 * SOLID lenses:
 *   - SRP: this module owns "asset → display string". Nothing else.
 *   - OCP: adding a new column to the list table = new key in
 *     `LIST_COLUMNS`, new entry in `projectListRow`. Extending here,
 *     not editing the runner.
 *   - DIP: pure functions, no transport coupling. The runner adapts
 *     this module's output to whatever sink it wants.
 */
import type { AssetManifest, AssetSummary } from '../schema/types.js'
import { formatAltStatus, formatBytes, formatFocalPoint, shortDate } from '../format.js'

/**
 * One row in the `gazetta assets list` table. Stable shape so
 * downstream consumers (output sink, future JSON renderer) can rely
 * on it.
 */
export interface ListRow {
  name: string
  kind: string
  size: string
  dims: string
  alt: string
  locales: string
  uploaded: string
}

/**
 * The columns rendered in `gazetta assets list`, in display order.
 * Header label + value selector + alignment. Adding a column =
 * append one entry; nothing else needs to change in the renderer.
 */
export const LIST_COLUMNS: readonly { key: keyof ListRow; header: string; align: 'start' | 'end' }[] = [
  { key: 'name', header: 'NAME', align: 'start' },
  { key: 'kind', header: 'KIND', align: 'start' },
  { key: 'size', header: 'SIZE', align: 'end' },
  { key: 'dims', header: 'DIMENSIONS', align: 'end' },
  { key: 'alt', header: 'ALT', align: 'start' },
  { key: 'locales', header: 'LOCALES', align: 'start' },
  { key: 'uploaded', header: 'UPLOADED', align: 'start' },
]

/**
 * Project an `AssetSummary` (returned by `listAssets`) into a
 * display row. Pure — no I/O. The summary already includes
 * `overrideLocales` (populated server-side from the directory
 * scan), so this is a pure mapping.
 */
export function projectListRow(summary: AssetSummary): ListRow {
  return {
    name: summary.name,
    kind: summary.kind,
    size: formatBytes(summary.size),
    dims: summary.width !== null && summary.height !== null ? `${summary.width}×${summary.height}` : '—',
    alt: formatAltStatus(summary.alt, 30),
    locales: summary.overrideLocales.length > 0 ? summary.overrideLocales.join(',') : '—',
    uploaded: shortDate(summary.uploadedAt),
  }
}

/**
 * Render rows as a column-aligned table. Returns lines (no
 * embedded newlines) — the caller emits them via its sink. Header
 * line is included as the first entry.
 *
 * `start` columns left-pad; `end` columns right-pad — matches
 * conventional table alignment (text left, numbers right).
 */
export function renderListTable(rows: readonly ListRow[]): string[] {
  if (rows.length === 0) return []

  const widths: Record<string, number> = {}
  for (const col of LIST_COLUMNS) {
    widths[col.key] = Math.max(col.header.length, ...rows.map(r => r[col.key].length))
  }

  const lines: string[] = []
  lines.push(LIST_COLUMNS.map(col => formatCell(col.header, widths[col.key]!, col.align)).join('  '))
  for (const row of rows) {
    lines.push(LIST_COLUMNS.map(col => formatCell(row[col.key], widths[col.key]!, col.align)).join('  '))
  }
  return lines
}

function formatCell(value: string, width: number, align: 'start' | 'end'): string {
  return align === 'start' ? value.padEnd(width) : value.padStart(width)
}

/**
 * Sections of the `gazetta assets info <name>` output. Each section
 * is "title" + ordered key-value pairs; the runner formats each
 * section uniformly. Decoupling this from the renderer means a future
 * `--format json` consumes the same data structure.
 */
interface InfoSection {
  title: string
  rows: readonly { label: string; value: string }[]
}

export interface InfoVariantRow {
  width: string
  size: string
  path: string
}

export interface InfoOverrideRow {
  selector: string
  bytes: 'bytes' | 'metadata only'
}

export interface InfoReferenceRow {
  /** `pages/home`, `fragments/header:fr`, etc. */
  path: string
}

export interface InfoOutput {
  /** Top-level metadata (kind, mime, hash, size, dims, alt, focal, uploaded). */
  metadata: InfoSection
  /** Variant ladder, when an image with variants. */
  variants: InfoVariantRow[]
  /** Locale/theme overrides (from `enumerateOverrideSlices`). */
  overrides: InfoOverrideRow[]
  /** Pages/fragments that reference this asset. */
  references: InfoReferenceRow[]
}

/**
 * Project a default manifest + override slices + ref list into the
 * structured `InfoOutput`. Pure — caller does the I/O to gather
 * inputs.
 */
export function projectInfo(input: {
  manifest: AssetManifest
  overrideSlices: readonly { selector: ReadonlyMap<string, string>; bytes: string | null }[]
  references: readonly { source: 'page' | 'fragment'; name: string; locale?: string }[]
}): InfoOutput {
  const { manifest, overrideSlices, references } = input

  const metadataRows: { label: string; value: string }[] = [
    { label: 'Kind', value: manifest.kind },
    { label: 'Type', value: manifest.mime },
    { label: 'Hash', value: manifest.hash },
    { label: 'Size', value: formatBytes(manifest.size) },
  ]
  if (manifest.width !== null && manifest.height !== null) {
    metadataRows.push({ label: 'Dimensions', value: `${manifest.width} × ${manifest.height}` })
  }
  metadataRows.push({ label: 'Alt', value: formatAltStatus(manifest.alt) })
  if (manifest.focalPoint !== undefined) {
    metadataRows.push({ label: 'Focal', value: formatFocalPoint(manifest.focalPoint) })
  }
  metadataRows.push({
    label: 'Uploaded',
    value: manifest.uploadedAt + (manifest.uploadedBy ? ` by ${manifest.uploadedBy}` : ''),
  })

  return {
    metadata: { title: 'metadata', rows: metadataRows },
    variants: manifest.variants.map(v => ({
      width: `${v.width}w`,
      size: formatBytes(v.size),
      path: v.path,
    })),
    overrides: overrideSlices.map(slice => ({
      selector: selectorToString(slice.selector),
      bytes: slice.bytes !== null ? 'bytes' : 'metadata only',
    })),
    references: references.map(ref => ({
      path: `${ref.source === 'page' ? 'pages' : 'fragments'}/${ref.name}${ref.locale ? `:${ref.locale}` : ''}`,
    })),
  }
}

/** Render a Selector map as `locale=fr theme=dark` for display. */
function selectorToString(selector: ReadonlyMap<string, string>): string {
  const parts: string[] = []
  for (const [dim, value] of selector) {
    parts.push(`${dim}=${value}`)
  }
  return parts.join(' ')
}
