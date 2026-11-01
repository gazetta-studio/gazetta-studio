import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access } from 'node:fs/promises'
import { createJiti } from 'jiti'
import type { TemplateFunction, StorageProvider } from './types.js'

interface LoadedTemplate {
  render: TemplateFunction
  schema: unknown
}

const cache = new Map<string, LoadedTemplate>()
/** Tracks which templates have been imported — reloads use jiti to bypass Node's module cache */
const importedPaths = new Set<string>()

const TEMPLATE_FILES = ['index.ts', 'index.tsx']

/** Filesystem existence check — templates always live on disk at absolute paths. */
async function fsExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function findTemplateFile(templatesDir: string, templateName: string): Promise<string | null> {
  for (const file of TEMPLATE_FILES) {
    const path = join(templatesDir, templateName, file)
    if (await fsExists(path)) return path
  }
  return null
}

async function importTemplate(templatePath: string): Promise<Record<string, unknown>> {
  if (!importedPaths.has(templatePath)) {
    importedPaths.add(templatePath)
    try {
      return await import(pathToFileURL(templatePath).href)
    } catch {
      const jiti = createJiti(pathToFileURL(templatePath).href, { jsx: true })
      return (await jiti.import(templatePath)) as Record<string, unknown>
    }
  }
  const freshJiti = createJiti(pathToFileURL(templatePath).href, { jsx: true, moduleCache: false })
  return (await freshJiti.import(templatePath)) as Record<string, unknown>
}

export async function loadTemplate(
  _storage: StorageProvider | undefined,
  templatesDir: string,
  templateName: string,
): Promise<LoadedTemplate> {
  const cached = cache.get(templateName)
  if (cached) return cached

  const templatePath = await findTemplateFile(templatesDir, templateName)
  if (!templatePath) {
    throw new Error(
      `Template "${templateName}" not found. Expected index.ts or index.tsx in ${join(templatesDir, templateName)}\n` +
        `  Available templates are in ${templatesDir}`,
    )
  }

  let mod: Record<string, unknown>
  try {
    mod = await importTemplate(templatePath)
  } catch (err) {
    throw new Error(`Failed to import template "${templateName}" from ${templatePath}: ${(err as Error).message}`)
  }

  const render = mod.default as TemplateFunction
  if (typeof render !== 'function') {
    throw new Error(
      `Template "${templateName}" at ${templatePath} does not export a default function. ` +
        `Got ${typeof render}. Templates must: export default (params) => ({ html, css, js })`,
    )
  }

  if (!mod.schema) {
    throw new Error(
      `Template "${templateName}" at ${templatePath} does not export a schema. ` +
        `Templates must: export const schema = z.object({ ... })`,
    )
  }

  const loaded: LoadedTemplate = {
    render,
    schema: mod.schema,
  }

  cache.set(templateName, loaded)
  return loaded
}

/**
 * Check if a custom editor file exists for a template. Editors live at
 * project level on local filesystem, so this reads via fs.access regardless
 * of what storage the admin app is bound to.
 */
export async function hasEditorFile(
  _storage: StorageProvider | undefined,
  editorsDir: string,
  templateName: string,
): Promise<boolean> {
  // Flat: admin/editors/hero.ts(x)
  if (await fsExists(join(editorsDir, `${templateName}.ts`))) return true
  if (await fsExists(join(editorsDir, `${templateName}.tsx`))) return true
  // Directory: admin/editors/hero/index.ts(x)
  if (await fsExists(join(editorsDir, templateName, 'index.ts'))) return true
  if (await fsExists(join(editorsDir, templateName, 'index.tsx'))) return true
  return false
}

export function invalidateTemplate(templateName: string): void {
  cache.delete(templateName)
}

export function invalidateAllTemplates(): void {
  cache.clear()
}
