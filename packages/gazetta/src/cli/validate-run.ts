/**
 * One run of `gazetta validate`'s checks: the site's validators (through the
 * scanner, as the admin's background scan runs them) on each content source,
 * the config validators and the project checks. Returns the issues;
 * reporting them is the report's job. `--base` runs it twice: on the
 * working tree and on the base commit (#1750).
 *
 * A content source is the repo's editing target, or a target named with
 * `--targets` (#1754). Targets get the content checks only, with the run's
 * templates; config and project checks run once, on the repo.
 */
import { createContentRoot, type ContentRoot } from '../content-root.js'
import { loadSite, type Site } from '../site-loader.js'
import type { SiteManifest, StorageProvider } from '../types.js'
import type { Issue, Validator } from '../validation/types.js'
import { checkProject, type ProjectIssue } from './project-checks.js'
import type { TemplateSelection } from './validate-render-check.js'
import { withCliSeverity } from './validate-severity.js'

/** Validators that render each page: slow, so only with `--include-quality`. */
export const QUALITY_VALIDATORS = new Set(['accessibility', 'html-validity', 'broken-links'])

export interface RunInput {
  siteDir: string
  projectRoot: string
  templatesDir: string
  includeQuality: boolean
  /** Targets whose stored content is checked too, with this run's templates. */
  targets?: readonly TargetSource[]
  /** With `--render`: render the items that use these templates and report throws (T8, #1755). */
  render?: TemplateSelection
}

/** A target's stored content, ready to check. */
export interface TargetSource {
  name: string
  storage: StorageProvider
  /** A static target bakes fragments into its pages, so it stores none to check. */
  static: boolean
}

/** One content source's issues: the repo (`target: null`) or a named target. */
export interface ContentIssues {
  target: string | null
  site: Site
  /** The scan's issues, each on an item, after the CLI's severity mapping. */
  itemIssues: Issue[]
}

export interface RunIssues {
  /** The repo first, then each target in the order named. */
  content: ContentIssues[]
  /** Issues about the site's config, on no item. */
  configIssues: Issue[]
  projectIssues: ProjectIssue[]
}

/** Thrown when the site's config or content can't be loaded at all. */
export class SiteLoadError extends Error {}

/** Thrown when a target's content can't be read; `gazetta validate` exits 2 (T10). */
export class TargetReadError extends Error {}

export async function runChecks(input: RunInput): Promise<RunIssues> {
  const { buildSourceContext } = await import('./bootstrap.js')
  let site: Site
  let source: Awaited<ReturnType<typeof buildSourceContext>>['source']
  try {
    const built = await buildSourceContext({ projectSiteDir: input.siteDir })
    source = built.source
    site = await loadSite({
      contentRoot: source.contentRoot,
      templatesDir: input.templatesDir,
      manifest: built.manifest,
    })
  } catch (err) {
    throw new SiteLoadError((err as Error).message)
  }

  const { defaultValidatorRegistry } = await import('../validation/default-registry.js')
  const all = defaultValidatorRegistry().all()
  const repoValidators = input.includeQuality ? all : all.filter(v => !QUALITY_VALIDATORS.has(v.name))

  const repo: ContentIssues = {
    target: null,
    site,
    itemIssues: await scan(site, source.storage, source.contentRoot, input.templatesDir, repoValidators),
  }

  // Targets: the content checks only, schema and references (T5). A static
  // target stores no fragments (they're baked into its pages at publish), so
  // its fragment reference checks would only report what isn't meant to be
  // there; the repo's own check covers the fragments.
  const contentValidators = all.filter(v => v.name === 'schema-conformance' || v.name.startsWith('referenced-'))
  const FRAGMENT_CHECKS = new Set(['referenced-fragment-exists', 'referenced-archived-without-alias'])
  const targets: ContentIssues[] = []
  for (const target of input.targets ?? []) {
    const contentRoot = createContentRoot(target.storage, '')
    let targetSite: Site
    try {
      targetSite = await loadSite({
        contentRoot,
        templatesDir: input.templatesDir,
        manifest: site.manifest as SiteManifest,
      })
    } catch (err) {
      throw new TargetReadError(`Couldn't read target \`${target.name}\`: ${(err as Error).message}`)
    }
    targets.push({
      target: target.name,
      site: targetSite,
      itemIssues: await scan(
        targetSite,
        target.storage,
        contentRoot,
        input.templatesDir,
        target.static ? contentValidators.filter(v => !FRAGMENT_CHECKS.has(v.name)) : contentValidators,
      ),
    })
  }

  // Site-config validators (targets, deploy adapters) check the whole config
  // once rather than per item, so the scanner never runs them.
  const configIssues: Issue[] = []
  for (const validator of repoValidators) {
    if (!validator.stages.includes('cli') || validator.stages.includes('background')) continue
    configIssues.push(
      ...(await validator.validate({
        stage: 'cli',
        site,
        contentRoot: source.contentRoot,
        storage: source.storage,
        scope: { kind: 'cli' },
      })),
    )
  }

  // --render: the same items publish would render, per content source (T8).
  if (input.render) {
    const { itemsToRender, renderItems } = await import('./validate-render-check.js')
    for (const source of [repo, ...targets]) {
      const items = itemsToRender(source.site, input.render)
      const where = source.target === null ? '' : ` on ${source.target}`
      console.log(`  Rendering ${items.length} item${items.length === 1 ? '' : 's'}${where}…`)
      source.itemIssues.push(...(await renderItems(source.site, items)))
    }
  }

  return {
    content: [repo, ...targets],
    configIssues,
    projectIssues: await checkProject(input.projectRoot, input.templatesDir),
  }
}

async function scan(
  site: Site,
  storage: StorageProvider,
  contentRoot: ContentRoot,
  templatesDir: string,
  validators: readonly Validator[],
): Promise<Issue[]> {
  const { createValidatorRegistry } = await import('../validation/registry.js')
  const { createValidationScanner } = await import('../validation/scanner.js')
  const { createMemoryCache } = await import('../cache/memory.js')
  const scanner = createValidationScanner({
    storage,
    contentRoot,
    registry: createValidatorRegistry([...validators]),
    cache: createMemoryCache(),
    siteOptions: { templatesDir, manifest: site.manifest },
    loadSiteImpl: async () => site,
  })
  await scanner.scanAll()
  // The CLI is the gate: some issues count higher here than in Site health (T7).
  return scanner.allIssues().map(withCliSeverity)
}
