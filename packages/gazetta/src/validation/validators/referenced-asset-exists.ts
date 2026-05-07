import type { ComponentEntry, InlineComponent } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'

/**
 * Every `_asset` reference in content points to an existing asset.
 *
 * Walks the manifest's content + recursive components. For each ref of shape
 * `{ _asset: "name" }`, checks the storage `assets/{name}.asset.json` (or
 * locale variants). Flags missing.
 *
 * Save-delta: only checks refs introduced by this save (callers prune the
 * scope to introduced refs before invoking).
 */
export const referencedAssetExists: Validator = {
  source: 'gazetta',
  name: 'referenced-asset-exists',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, storage } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    const issues: Issue[] = []
    const refs = collectAssetRefs(manifest.content as Record<string, unknown> | undefined, '')
    for (const child of manifestComponents(manifest)) {
      collectFromEntry(child, '', refs)
    }

    for (const ref of refs) {
      const exists = await assetManifestExists(storage, ref.name)
      if (!exists) {
        issues.push({
          validator: 'referenced-asset-exists',
          severity: 'error',
          message: `Asset "${ref.name}" referenced but not found in the asset library.`,
          itemPath: scope.item.itemPath,
          contentPath: ref.path || undefined,
        })
      }
    }
    return issues
  },
}

interface AssetRef {
  name: string
  path: string
}

function collectAssetRefs(content: Record<string, unknown> | undefined, parentPath: string): AssetRef[] {
  const out: AssetRef[] = []
  walkContent(content, parentPath, out)
  return out
}

function collectFromEntry(entry: ComponentEntry, parentPath: string, out: AssetRef[]): void {
  if (typeof entry === 'string') return // fragment ref — not an asset
  const inline = entry as InlineComponent
  const path = parentPath ? `${parentPath}/${inline.name}` : inline.name
  walkContent(inline.content as Record<string, unknown> | undefined, path, out)
  if (inline.components) {
    for (const child of inline.components) {
      collectFromEntry(child, path, out)
    }
  }
}

function walkContent(value: unknown, path: string, out: AssetRef[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkContent(item, path, out)
    return
  }
  const obj = value as Record<string, unknown>
  if (typeof obj._asset === 'string') {
    out.push({ name: obj._asset, path })
    return
  }
  for (const v of Object.values(obj)) walkContent(v, path, out)
}

async function assetManifestExists(
  storage: { exists(path: string): Promise<boolean> },
  name: string,
): Promise<boolean> {
  return storage.exists(`assets/${name}.asset.json`)
}
