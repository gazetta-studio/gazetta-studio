/**
 * The checks `gazetta validate` runs on the project's layout rather than on
 * content: templates that don't load (#1665), custom fields a schema names
 * that don't exist, and custom editors without a template. They return
 * issues, which the validate report places with their template or under
 * "other".
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createFilesystemProvider } from '../providers/filesystem.js'
import { findTemplateFile, loadTemplate } from '../template-loader.js'

export interface ProjectIssue {
  validator: 'template-loads' | 'custom-field-exists' | 'orphaned-editor'
  severity: 'error' | 'warn'
  message: string
  /** The template the issue is about, when it is about one. */
  template?: string
  /** The project file the issue is about, relative to the project root, when it isn't a template. */
  path?: string /** The schema field the issue is about (a missing custom field's property). */
  field?: string
}

/** Folders under `templates/` that are templates: as the scanner, not `_shared/` or a folder without an index file. */
export async function templateNames(templatesDir: string): Promise<string[]> {
  if (!existsSync(templatesDir)) return []
  const names: string[] = []
  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    if (await findTemplateFile(templatesDir, entry.name)) names.push(entry.name)
  }
  return names.sort()
}

export async function checkProject(projectRoot: string, templatesDir: string): Promise<ProjectIssue[]> {
  const issues: ProjectIssue[] = []
  const templates = await templateNames(templatesDir)
  const adminDir = join(projectRoot, 'admin')

  const editorsDir = join(adminDir, 'editors')
  if (existsSync(editorsDir)) {
    for (const file of readdirSync(editorsDir).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      if (!templates.includes(file.replace(/\.(ts|tsx)$/, ''))) {
        issues.push({
          validator: 'orphaned-editor',
          severity: 'warn',
          message: `orphaned editor: admin/editors/${file} — no matching template`,
          path: `admin/editors/${file}`,
        })
      }
    }
  }

  const fieldsDir = join(adminDir, 'fields')
  const fieldFiles = existsSync(fieldsDir)
    ? readdirSync(fieldsDir)
        .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
        .map(f => f.replace(/\.(ts|tsx)$/, ''))
    : []
  const storage = createFilesystemProvider()
  for (const template of templates) {
    let loaded: Awaited<ReturnType<typeof loadTemplate>>
    try {
      loaded = await loadTemplate(storage, templatesDir, template)
    } catch (err) {
      // Once per template; the pages using it say they can't be checked (#1665).
      issues.push({
        validator: 'template-loads',
        severity: 'error',
        message: `template ${template} couldn't be loaded — ${(err as Error).message}`,
        template,
      })
      continue
    }
    let props: Record<string, Record<string, unknown>> | undefined
    try {
      props = (z.toJSONSchema(loaded.schema as z.ZodType) as { properties?: typeof props }).properties
    } catch {
      continue // a schema JSON Schema can't express has no field references to check
    }
    for (const [prop, def] of Object.entries(props ?? {})) {
      const field = def.field as string | undefined
      if (field && !fieldFiles.includes(field)) {
        issues.push({
          validator: 'custom-field-exists',
          severity: 'error',
          message: `template ${template}.${prop} references field "${field}" — not found in admin/fields/`,
          template,
          field: prop,
        })
      }
    }
  }
  return issues
}
