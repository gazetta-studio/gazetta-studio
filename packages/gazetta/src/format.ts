/**
 * Tiny, isomorphic display formatters used across the CLI, the admin
 * UI, and the asset library. Pure functions — no DOM, no `process`,
 * no `console`. Safe to import from any context.
 *
 * Extracted because three+ callers were repeating the same logic
 * (per the project rule). Centralising here means a future change
 * to KB / MB cutoffs or rounding policy lands in one place.
 */

/**
 * Render a byte count as a short human string: `512 B`, `1.2 KB`,
 * `4.7 MB`. Single decimal place above 1 KB. Larger units (GB, TB)
 * deliberately not handled — the asset cap is 50 MB by default and
 * file sizes that big should surface as raw numbers in any UI that
 * shows them.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render the three-state alt model for a fixed-width table or label.
 *
 *   - meaningful string      → the string (truncated past `maxLength` chars)
 *   - empty string           → `(decorative)`
 *   - null                   → `(unset)`
 *
 * The truncation matters in tabular contexts (CLI `assets list`); UI
 * detail panes should pass `Infinity` to keep the full text.
 */
export function formatAltStatus(alt: string | null, maxLength = Infinity): string {
  if (alt === null) return '(unset)'
  if (alt === '') return '(decorative)'
  if (Number.isFinite(maxLength) && alt.length > maxLength) {
    return `${alt.slice(0, Math.max(0, maxLength - 3))}...`
  }
  return alt
}

/**
 * Render a focal point as a percentage pair: `42% × 13%`. Both 0-1
 * normalized inputs and `null` are accepted; null returns the empty
 * string so callers can append it conditionally.
 */
export function formatFocalPoint(fp: { x: number; y: number } | null | undefined): string {
  if (!fp) return ''
  return `${Math.round(fp.x * 100)}% × ${Math.round(fp.y * 100)}%`
}

/**
 * Short ISO-date prefix for tabular display: `2026-04-22`. Inputs
 * that aren't ISO-shaped pass through unchanged so the CLI doesn't
 * silently mangle unexpected manifest values.
 */
export function shortDate(iso: string): string {
  // Cheap ISO-shape sniff: yyyy-mm-dd at the start.
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10)
  return iso
}
