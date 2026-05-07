import { z } from 'zod'
import type { ComponentEntry, FragmentManifest, InlineComponent, PageManifest, StorageProvider } from '../../types.js'
import { loadTemplate } from '../../template-loader.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'
import { manifestComponents } from '../types.js'

/**
 * Parse content against the template's Zod schema. Surfaces `warn` when
 * content doesn't conform — typically content that bypassed the admin form
 * (direct file edits, git pulls bringing in old shape, schema migrations
 * mid-flight).
 *
 * Background scope only — save-delta runs the form's own Zod validation
 * already (the admin UI uses @rjsf which validates before submit). Pre-publish
 * gate (Cut 4) promotes this to `error`.
 *
 * Walks the manifest + recursive inline components. Each component is parsed
 * against its declared template's schema. Failures emit one issue per zod
 * error with `contentPath` set to the failing field path.
 */
export const schemaConformance: Validator = {
  source: 'gazetta',
  name: 'schema-conformance',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity(stage) {
    return stage === 'pre-publish' ? 'error' : 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, storage } = input
    if (scope.kind !== 'background' && scope.kind !== 'cli') return []

    const templatesDir = site.templatesDir
    if (!templatesDir) return []

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
  const parsed = (tpl.schema as z.ZodTypeAny).safeParse(content)
  if (parsed.success) return []
  return parsed.error.issues.map(issue => ({
    validator: 'schema-conformance',
    severity: 'warn' as const,
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
