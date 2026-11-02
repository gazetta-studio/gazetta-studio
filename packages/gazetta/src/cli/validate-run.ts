/**
 * One run of `gazetta validate`'s checks on one project folder: the site's
 * validators (through the scanner, as the admin's background scan runs
 * them), the config validators, and the project checks. Returns the issues;
 * reporting them is the report's job. `--base` runs it twice: on the
 * working tree and on the base commit (#1750).
 */
import { loadSite, type Site } from '../site-loader.js'
import type { Issue } from '../validation/types.js'
import { checkProject, type ProjectIssue } from './project-checks.js'
import { withCliSeverity } from './validate-severity.js'

/** Validators that render each page: slow, so only with `--include-quality`. */
export const QUALITY_VALIDATORS = new Set(['accessibility', 'html-validity', 'broken-links'])

export interface RunInput {
  siteDir: string
  projectRoot: string
  templatesDir: string
  includeQuality: boolean
}

export interface RunIssues {
  site: Site
  /** The scan's issues, each on an item, after the CLI's severity mapping. */
  itemIssues: Issue[]
  /** Issues about the site's config, on no item. */
  configIssues: Issue[]
  projectIssues: ProjectIssue[]
}

/** Thrown when the site's config or content can't be loaded at all. */
export class SiteLoadError extends Error {}

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
  const { createValidatorRegistry } = await import('../validation/registry.js')
  const fullRegistry = defaultValidatorRegistry()
  const registry = input.includeQuality
    ? fullRegistry
    : createValidatorRegistry(fullRegistry.all().filter(v => !QUALITY_VALIDATORS.has(v.name)))

  const { createValidationScanner } = await import('../validation/scanner.js')
  const { createMemoryCache } = await import('../cache/memory.js')
  const scanner = createValidationScanner({
    storage: source.storage,
    contentRoot: source.contentRoot,
    registry,
    cache: createMemoryCache(),
    siteOptions: { templatesDir: input.templatesDir, manifest: site.manifest },
    loadSiteImpl: async () => site,
  })
  await scanner.scanAll()

  // Site-config validators (targets, deploy adapters) check the whole config
  // once rather than per item, so the scanner never runs them.
  const configIssues: Issue[] = []
  for (const validator of registry.forStage('cli')) {
    if (validator.stages.includes('background')) continue
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

  return {
    site,
    // The CLI is the gate: some issues count higher here than in Site health (T7).
    itemIssues: scanner.allIssues().map(withCliSeverity),
    configIssues,
    projectIssues: await checkProject(input.projectRoot, input.templatesDir),
  }
}
