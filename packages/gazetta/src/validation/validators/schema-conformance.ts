import { z } from 'zod'
import type { ComponentEntry, FragmentManifest, InlineComponent, PageManifest, StorageProvider } from '../../types.js'
import { findTemplateFile, loadTemplate } from '../../template-loader.js'
import { touchedComponents } from '../touched-components.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'

/**
 * Parse content against the template's Zod schema.
 *
 * At save-delta it's an error for the components the save touches
 * (design-agent-access.md Q49): new ones, or ones whose template or
 * content changed. Every caller goes through it (the admin form, tokens,
 * scripts), so the form's own validation isn't relied on. Untouched
 * components aren't checked, so content an earlier template change made
 * invalid still saves when something else is edited. A touched
 * component whose template exists but won't load refuses the save.
 *
 * In the background scan and `gazetta validate` it's a warning for every
 * component: typically content that bypassed the admin (direct file
 * edits, git pulls, schema changes mid-flight).
 *
 * Walks the manifest + recursive inline components. Each component is parsed
 * against its declared template's schema. Failures emit one issue per zod
 * error with `contentPath` set to the failing field path.
 */
export const schemaConformance: Validator = {
  source: 'gazetta',
  name: 'schema-conformance',
  stages: ['save-delta', 'background', 'pre-publish', 'cli'] as const,

  defaultSeverity(stage) {
    return stage === 'pre-publish' || stage === 'save-delta' ? 'error' : 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, storage } = input
    const templatesDir = site.templatesDir
    if (!templatesDir) return []

    if (scope.kind === 'save-delta') {
      const issues: Issue[] = []
      for (const c of touchedComponents(scope.before, scope.after)) {
        issues.push(...(await checkTouched(scope.item.itemPath, c.template, c.content, c.path, storage, templatesDir)))
      }
      return issues
    }
    if (scope.kind !== 'background' && scope.kind !== 'cli') return []

    if (scope.kind === 'background') {
      const manifest = scope.manifest
      return await checkManifest(scope.item.itemPath, manifest, storage, templatesDir)
    }

    // CLI: walk the whole site
    const issues: Issue[] = []
    for (const [, page] of site.pages) {
      issues.push(...(await checkManifest(`${page.dir}/page.json`, page, storage, templatesDir)))
    }
    for (const [, frag] of site.fragments) {
      issues.push(...(await checkManifest(`${frag.dir}/fragment.json`, frag, storage, templatesDir)))
    }
    return issues
  },
}

async function checkManifest(
  itemPath: string,
  manifest: PageManifest | FragmentManifest,
  storage: StorageProvider,
  templatesDir: string,
): Promise<Issue[]> {
  const issues: Issue[] = []
  // The manifest itself has a template + content; parse those, then descend.
  if (manifest.template && manifest.content !== undefined) {
    issues.push(...(await checkOne(itemPath, manifest.template, manifest.content, '', storage, templatesDir)))
  }
  for (const child of manifestComponents(manifest)) {
    await collectFromEntry(child, '', issues, itemPath, storage, templatesDir)
  }
  return issues
}

async function collectFromEntry(
  entry: ComponentEntry,
  parentPath: string,
  out: Issue[],
  itemPath: string,
  storage: StorageProvider,
  templatesDir: string,
): Promise<void> {
  if (typeof entry === 'string') return // fragment ref — schema checked when fragment is scanned
  const inline = entry as InlineComponent
  const path = parentPath ? `${parentPath}/${inline.name}` : inline.name
  if (inline.template && inline.content !== undefined) {
    out.push(...(await checkOne(itemPath, inline.template, inline.content, path, storage, templatesDir)))
  }
  if (inline.components) {
    for (const child of inline.components) {
      await collectFromEntry(child, path, out, itemPath, storage, templatesDir)
    }
  }
}

/**
 * A touched component at save. A missing template is left to
 * referenced-template-exists; one that exists but won't load, or whose
 * schema can't parse, refuses the save rather than passing unchecked.
 */
async function checkTouched(
  itemPath: string,
  templateName: string,
  content: unknown,
  contentPath: string,
  storage: StorageProvider,
  templatesDir: string,
): Promise<Issue[]> {
  if (!(await findTemplateFile(templatesDir, templateName))) return []
  let schema: unknown
  try {
    schema = (await loadTemplate(storage, templatesDir, templateName)).schema
  } catch (err) {
    return [unloadable(itemPath, templateName, contentPath, (err as Error).message)]
  }
  if (typeof (schema as { safeParse?: unknown })?.safeParse !== 'function') {
    return [unloadable(itemPath, templateName, contentPath, 'its schema is not a Zod schema')]
  }
  return parseIssues(itemPath, schema as z.ZodTypeAny, content, contentPath, 'error')
}

function unloadable(itemPath: string, templateName: string, contentPath: string, reason: string): Issue {
  return {
    validator: 'schema-conformance',
    severity: 'error',
    message: `Template "${templateName}" couldn't be loaded, so this content can't be checked: ${reason}`,
    itemPath,
    contentPath: contentPath || undefined,
  }
}

async function checkOne(
  itemPath: string,
  templateName: string,
  content: unknown,
  contentPath: string,
  storage: StorageProvider,
  templatesDir: string,
): Promise<Issue[]> {
  const tpl = await safeLoadTemplate(storage, templatesDir, templateName)
  if (!tpl) return [] // template missing — referenced-template-exists handles this
  return parseIssues(itemPath, tpl.schema as z.ZodTypeAny, content, contentPath, 'warn')
}

function parseIssues(
  itemPath: string,
  schema: z.ZodTypeAny,
  content: unknown,
  contentPath: string,
  severity: Issue['severity'],
): Issue[] {
  const parsed = schema.safeParse(content)
  if (parsed.success) return []
  return parsed.error.issues.map(issue => ({
    validator: 'schema-conformance',
    severity,
    message: `${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`,
    itemPath,
    contentPath: contentPath || undefined,
  }))
}

async function safeLoadTemplate(
  storage: StorageProvider,
  templatesDir: string,
  templateName: string,
): Promise<{ render: unknown; schema: unknown } | null> {
  try {
    return await loadTemplate(storage, templatesDir, templateName)
  } catch {
    return null
  }
}
