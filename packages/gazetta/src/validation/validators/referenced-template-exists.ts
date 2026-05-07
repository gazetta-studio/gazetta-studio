import type { ComponentEntry, InlineComponent } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'
import { join } from 'node:path'

/**
 * Every `template` field on a manifest or inline component names a template
 * that exists at `templates/{name}/`.
 *
 * Walks the manifest + recursive components. Each `template` string is
 * checked against the templates directory for an `index.{ts,tsx,js}` entry.
 */
export const referencedTemplateExists: Validator = {
  source: 'gazetta',
  name: 'referenced-template-exists',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'save-delta' && scope.kind !== 'background') return []
    const manifest = scope.kind === 'save-delta' ? scope.after : scope.manifest

    const templatesDir = site.templatesDir
    if (!templatesDir) return [] // no templates configured — can't check

    const issues: Issue[] = []
    const refs: Array<{ name: string; path: string }> = []
    if (manifest.template) refs.push({ name: manifest.template, path: '' })
    for (const child of manifestComponents(manifest)) {
      collectTemplateRefs(child, '', refs)
    }

    for (const ref of refs) {
      const exists = await templateDirExists(templatesDir, ref.name)
      if (!exists) {
        issues.push({
          validator: 'referenced-template-exists',
          severity: 'error',
          message: `Template "${ref.name}" referenced but not found in templates/.`,
          itemPath: scope.item.itemPath,
          contentPath: ref.path || undefined,
        })
      }
    }
    return issues
  },
}

function collectTemplateRefs(
  entry: ComponentEntry,
  parentPath: string,
  out: Array<{ name: string; path: string }>,
): void {
  if (typeof entry === 'string') return // fragment ref — checked by referenced-fragment-exists
  const inline = entry as InlineComponent
  const path = parentPath ? `${parentPath}/${inline.name}` : inline.name
  if (inline.template) out.push({ name: inline.template, path })
  if (inline.components) {
    for (const child of inline.components) {
      collectTemplateRefs(child, path, out)
    }
  }
}

async function templateDirExists(templatesDir: string, name: string): Promise<boolean> {
  const fs = await import('node:fs/promises')
  const candidates = ['index.ts', 'index.tsx', 'index.js', 'index.jsx']
  for (const file of candidates) {
    try {
      await fs.access(join(templatesDir, name, file))
      return true
    } catch {
      // continue
    }
  }
  return false
}
