/**
 * Shared decision for whether a stored file may be served to a visitor.
 * Used by static `gazetta serve`; the worker, ESI serve, the static
 * deploy adapters and the probe reuse the same function (design:
 * .claude/rules/design-public-storage.md Q4). Free of server-specific
 * code so every surface shares one rule.
 *
 * Input is the decoded, normalised path (after `%2e%2e` has become
 * `..` and been resolved).
 *
 * A path is private when:
 * - any segment starts with `.` (covers `.gazetta/`, per-item
 *   `.{hash}.hash` / `.pub-*` sidecars, and unresolved `..` segments),
 *   except a first segment of exactly `.well-known`, which stays public
 *   (ACME challenges, security.txt, app association files) while
 *   dot-prefixed segments below it remain private;
 * - the final segment is one of Gazetta's reserved manifest names:
 *   `page.json`, `page.<anything>.json`, `fragment.json`,
 *   `fragment.<anything>.json`, `<name>.asset.json`,
 *   `<name>.asset.<anything>.json`. Any suffix matches, not only valid
 *   locales, because the site loader accepts any suffix. The match is
 *   case-insensitive: deployments on case-insensitive volumes resolve
 *   `PAGE.JSON` to the same stored file, and no public file needs a
 *   case variant of a reserved name.
 */

/**
 * Whether a file name is one of Gazetta's reserved manifest names. Shared
 * by `isPublicSitePath` and the publish copies that leave manifests off
 * public targets (design-public-storage.md Q4). Checked without a regular
 * expression: the name comes from storage listings and request paths, and
 * `^[^/]+\.asset(?:\.[^/]+)?\.json$` backtracks polynomially on names
 * repeating `..asset.`.
 */
export function isManifestFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.includes('/') || !lower.endsWith('.json')) return false
  const base = lower.slice(0, -'.json'.length)
  for (const kind of ['page', 'fragment']) {
    if (base === kind || (base.startsWith(`${kind}.`) && base.length > kind.length + 1)) return true
  }
  // `<name>.asset` or `<name>.asset.<suffix>`, with a non-empty name and suffix.
  for (let i = base.indexOf('.asset', 1); i !== -1; i = base.indexOf('.asset', i + 1)) {
    const end = i + '.asset'.length
    if (end === base.length || (base[end] === '.' && end + 1 < base.length)) return true
  }
  return false
}

export function isPublicSitePath(path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  const start = segments[0] === '.well-known' ? 1 : 0
  for (let i = start; i < segments.length; i++) {
    if (segments[i].startsWith('.')) return false
  }
  const last = segments[segments.length - 1]
  if (last !== undefined && isManifestFileName(last)) return false
  return true
}
