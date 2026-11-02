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
 * edits, git pulls, schema changes mid-flight). A template that exists but
 * won't load is an error, once per item that uses it (#1665): the item's
 * content can't be checked. `gazetta validate` also names the template
 * itself once.
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
  const ctx: ItemContext = { itemPath, storage, templatesDir, unloadable: new Set() }
  // The manifest itself has a template + content; parse those, then descend.
  if (manifest.template && manifest.content !== undefined) {
    issues.push(...(await checkOne(ctx, manifest.template, manifest.content, '')))
  }
  for (const child of manifestComponents(manifest)) {
    await collectFromEntry(child, '', issues, ctx)
  }
  return issues
}

/** One item's walk: each template that won't load is reported once for the item. */
interface ItemContext {
  itemPath: string
  storage: StorageProvider
  templatesDir: string
  unloadable: Set<string>
}

async function collectFromEntry(
  entry: ComponentEntry,
  parentPath: string,
  out: Issue[],
  ctx: ItemContext,
): Promise<void> {
  if (typeof entry === 'string') return // fragment ref — schema checked when fragment is scanned
  const inline = entry as InlineComponent
  const path = parentPath ? `${parentPath}/${inline.name}` : inline.name
  if (inline.template && inline.content !== undefined) {
    out.push(...(await checkOne(ctx, inline.template, inline.content, path)))
  }
  if (inline.components) {
    for (const child of inline.components) {
      await collectFromEntry(child, path, out, ctx)
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
  ctx: ItemContext,
  templateName: string,
  content: unknown,
  contentPath: string,
): Promise<Issue[]> {
  if (ctx.unloadable.has(templateName)) return []
  // A missing template is referenced-template-exists's to report.
  if (!(await findTemplateFile(ctx.templatesDir, templateName))) return []
  let schema: unknown
  try {
    schema = (await loadTemplate(ctx.storage, ctx.templatesDir, templateName)).schema
  } catch (err) {
    ctx.unloadable.add(templateName)
    return [unloadable(ctx.itemPath, templateName, contentPath, (err as Error).message)]
  }
  if (typeof (schema as { safeParse?: unknown })?.safeParse !== 'function') {
    ctx.unloadable.add(templateName)
    return [unloadable(ctx.itemPath, templateName, contentPath, 'its schema is not a Zod schema')]
  }
  return parseIssues(ctx.itemPath, schema as z.ZodTypeAny, content, contentPath, 'warn')
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
    ...(issue.path.length ? { field: issue.path.join('.') } : {}),
  }))
}
