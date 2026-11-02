/**
 * `gazetta validate --render`: render the content that uses a changed
 * template, as publish renders it, and report each template that throws
 * (design-template-check.md T8, #1755). Nothing is written.
 *
 * Three steps, each its own function: which templates changed (a git diff),
 * which items use them (template impact, through fragments too), and render
 * each item and collect the throws. The issues join the run's other content
 * issues, so the report and `--base`'s comparison treat them like any other.
 */
import { execFileSync } from 'node:child_process'
import { isArchived } from '../archive-helpers.js'
import { renderFragmentRendered, renderPageStatic } from '../publish-renderers.js'
import { thrownByTemplate } from '../renderer.js'
import { allFragmentEntries, allPageEntries, type Site } from '../site-loader.js'
import type { FragmentManifest, PageManifest } from '../types.js'
import { computeTemplateImpact } from '../validation/template-impact.js'
import type { Issue } from '../validation/types.js'

/** Every template, or the named ones. */
export type TemplateSelection = 'all' | ReadonlySet<string>

/** Renders at once; each is CPU-bound in-process work, so a few are enough. */
const CONCURRENCY = 8

/**
 * Template names from changed paths relative to `templates/`
 * (`hero/index.tsx` → `hero`). A change outside a template's own folder
 * (a file in `templates/` itself, or `_shared/`) can reach any template,
 * so it selects every template.
 */
export function templatesFromPaths(paths: readonly string[]): TemplateSelection {
  const names = new Set<string>()
  for (const path of paths) {
    const [first, ...rest] = path.split('/')
    if (!first) continue
    if (rest.length === 0 || first.startsWith('_')) return 'all'
    names.add(first)
  }
  return names
}

/** Templates whose folder differs between `baseSha` and the working tree, added and uncommitted ones included. */
export function changedTemplates(baseSha: string, templatesDir: string): TemplateSelection {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: templatesDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')
      .filter(Boolean)
  // `--relative` and `ls-files` both give paths relative to `templatesDir`.
  const changed = git(['diff', '--name-only', '--relative', baseSha, '--', '.'])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', '.'])
  return templatesFromPaths([...changed, ...untracked])
}

interface RenderItem {
  kind: 'page' | 'fragment'
  name: string
  locale?: string
  itemPath: string
  manifest: PageManifest | FragmentManifest
}

/** Every page and fragment version that uses a selected template, directly or through a fragment. */
export function itemsToRender(site: Site, templates: TemplateSelection): RenderItem[] {
  const all: RenderItem[] = [
    ...allPageEntries(site).map(e => ({
      kind: 'page' as const,
      name: e.name,
      locale: e.locale,
      itemPath: `${e.page.dir}/page${e.locale ? `.${e.locale}` : ''}.json`,
      manifest: e.page,
    })),
    ...allFragmentEntries(site).map(e => ({
      kind: 'fragment' as const,
      name: e.name,
      locale: e.locale,
      itemPath: `${e.fragment.dir}/fragment${e.locale ? `.${e.locale}` : ''}.json`,
      manifest: e.fragment,
    })),
  ].filter(i => !isArchived(i.manifest))
  if (templates === 'all') return all
  const wanted = new Set<string>()
  for (const template of templates)
    for (const item of computeTemplateImpact(site, template, () => [], { throughFragments: true }).items)
      wanted.add(item.itemPath)
  return all.filter(i => wanted.has(i.itemPath))
}

/** Render each item as publish would and return one issue per item that throws. */
export async function renderItems(site: Site, items: readonly RenderItem[]): Promise<Issue[]> {
  const issues: (Issue | null)[] = new Array(items.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      const item = items[i]
      try {
        if (item.kind === 'page') await renderPageStatic(item.name, { site, locale: item.locale })
        else await renderFragmentRendered(item.name, { site, locale: item.locale })
      } catch (err) {
        // The template that threw, or the item's own when the error can't say.
        const template = thrownByTemplate(err) ?? item.manifest.template ?? ''
        const message = err instanceof Error ? err.message : String(err)
        issues[i] = {
          validator: 'render',
          severity: 'error',
          message: `\`${template}\` throws when rendering: ${message}`,
          itemPath: item.itemPath,
          subject: template,
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return issues.filter((i): i is Issue => i !== null)
}
