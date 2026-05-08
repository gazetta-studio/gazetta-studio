/**
 * altRequired validator (Validation Cut 3).
 *
 * Walks the page/fragment's template schema, finds fields declared as
 * `embeddedAsset({ altRequired: true })`, then for each `_asset` reference
 * in content at those paths verifies that the **resolved alt** is non-null.
 *
 * The resolved alt is the per-reference override (`{ _asset, alt }` — alt
 * field on the reference itself); when absent, the asset's own default alt
 * (read from `assets/{name}.asset.json`); when both null, the issue fires.
 *
 * Locked at `error` severity at every stage per design-validation.md:
 * "altRequired is `error` at save-delta + background; warns are not promoted
 *  (template author's intent IS the gate)."
 *
 * # SOLID lenses
 *
 *   - SRP: validator owns alt-resolution; the schema walker (`findAltRequiredPaths`)
 *     is its own module, testable in isolation.
 *   - DIP: depends on `loadTemplate` for the schema and `storage.exists` /
 *     `storage.readFile` for asset metadata. No direct coupling to a renderer.
 *   - OCP: adding new altRequired field shapes (e.g., a future `videoAsset`
 *     with required captions) is one new walker case + one validator branch.
 */
import { z } from 'zod'
import { loadTemplate } from '../../template-loader.js'
import type { FragmentManifest, PageManifest, StorageProvider } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { findAltRequiredPaths, readAtPath } from '../alt-required-walker.js'

interface AssetRef {
  _asset?: string
  alt?: string
}

export const altRequired: Validator = {
  source: 'gazetta',
  name: 'altRequired',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, storage } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    const templatesDir = site.templatesDir
    if (!templatesDir) return []
    if (!manifest.template) return []

    const tpl = await tryLoadTemplate(storage, templatesDir, manifest.template)
    if (!tpl) return [] // template missing — referenced-template-exists handles it

    const jsonSchema = await safeToJsonSchema(tpl.schema)
    if (!jsonSchema) return []

    const requiredPaths = findAltRequiredPaths(jsonSchema)
    if (requiredPaths.length === 0) return []

    const issues: Issue[] = []
    for (const path of requiredPaths) {
      const refs = readAtPath(manifest.content, path)
      for (const raw of refs) {
        const ref = raw as AssetRef | null | undefined
        if (!ref || typeof ref !== 'object' || !ref._asset) continue
        if (typeof ref.alt === 'string' && ref.alt.length > 0) continue // per-ref override satisfies
        // Per-ref alt is empty string ('') means decorative — also valid.
        if (ref.alt === '') continue
        const fallback = await readAssetAlt(storage, ref._asset)
        if (typeof fallback === 'string') continue // asset default satisfies
        issues.push({
          validator: 'altRequired',
          severity: 'error',
          message:
            `Asset "${ref._asset}" referenced at "${path}" requires alt text. ` +
            `Set alt on the reference, or set the asset's default alt.`,
          itemPath: scope.item.itemPath,
          contentPath: path,
        })
      }
    }
    return issues
  },
}

async function tryLoadTemplate(
  storage: StorageProvider,
  templatesDir: string,
  name: string,
): Promise<{ schema: unknown } | null> {
  try {
    return await loadTemplate(storage, templatesDir, name)
  } catch {
    return null
  }
}

async function safeToJsonSchema(schema: unknown): Promise<Record<string, unknown> | null> {
  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Read the asset's default alt from `assets/{name}.asset.json`. Returns
 * the alt string when set (including empty string for decorative); `null`
 * when the asset doesn't exist OR its alt is null/undefined.
 */
async function readAssetAlt(storage: StorageProvider, name: string): Promise<string | null> {
  const path = `assets/${name}.asset.json`
  try {
    if (!(await storage.exists(path))) return null
    const raw = await storage.readFile(path)
    const parsed = JSON.parse(raw) as { alt?: string | null }
    if (typeof parsed.alt === 'string') return parsed.alt
    return null
  } catch {
    return null
  }
}
