/**
 * `gazetta validate --base`: which of the working tree's problems the base
 * commit already had (design-template-check.md T2, Open question 1, #1750).
 *
 * A head issue is already broken when a base issue has the same key; every
 * other head issue is new, and only new issues fail the run. No key uses the
 * message: a schema change can reword Zod's, and the quality checks' carry
 * line numbers and selectors that move with any edit. Item problems other
 * than schema problems use the issue's `subject` instead, the missing
 * reference or the quality rule: an asset problem's path stops at the
 * component, so two missing assets in one component would otherwise share a
 * key (Seer on #1751). Two problems of the same quality rule on one page
 * count as one.
 *
 * | Issue                         | Key                                                  | Example                                                        |
 * |-------------------------------|------------------------------------------------------|----------------------------------------------------------------|
 * | Schema problem                | validator, item (kind, name, language), component, field | `schema-conformance` page `home` `fr`, `hero`, `title`     |
 * | Other problem on an item      | validator, item, contentPath, subject                | `referenced-asset-exists` page `about`, `hero`, `logo`; `html-validity` page `home`, `attr-quotes` |
 * | Site config                   | validator, config path, subject                      | `public-storage-config` `site.config.ts:targets.production` `editable` |
 * | Template or project file      | validator, template or file, field                   | `custom-field-exists` `hero` `color`; `orphaned-editor` `admin/editors/x.tsx` |
 *
 * Two head issues with one base issue's key are both already broken.
 * Items are matched by kind, name and language, not by file path: the base
 * commit's files live in another folder. With `--targets`, the place (the
 * repo or a target's name) is part of an item's key (#1754).
 */
import type { Issue } from '../validation/types.js'
import type { ProjectIssue } from './project-checks.js'
import { itemIndex } from './validate-report.js'
import type { RunIssues } from './validate-run.js'

/** A run's issues, by content source (the repo, then each target) plus config and project problems. */
export type IssueLists = RunIssues

export interface Comparison {
  /** Problems the base commit didn't have: they count and fail the run. */
  fresh: IssueLists
  /** Problems the base commit already had: listed, not counted. */
  alreadyBroken: IssueLists
}

export function compareRuns(head: RunIssues, base: RunIssues): Comparison {
  const baseKeys = new Set(keys(base))
  const fresh: IssueLists = { content: [], configIssues: [], projectIssues: [] }
  const alreadyBroken: IssueLists = { content: [], configIssues: [], projectIssues: [] }
  for (const source of head.content) {
    const items = itemIndex(source.site)
    const split = { fresh: [] as Issue[], already: [] as Issue[] }
    for (const issue of source.itemIssues)
      (baseKeys.has(itemKey(issue, items, source.target)) ? split.already : split.fresh).push(issue)
    fresh.content.push({ ...source, itemIssues: split.fresh })
    alreadyBroken.content.push({ ...source, itemIssues: split.already })
  }
  for (const issue of head.configIssues)
    (baseKeys.has(configKey(issue)) ? alreadyBroken : fresh).configIssues.push(issue)
  for (const issue of head.projectIssues)
    (baseKeys.has(projectKey(issue)) ? alreadyBroken : fresh).projectIssues.push(issue)
  return { fresh, alreadyBroken }
}

function keys(run: RunIssues): string[] {
  return [
    ...run.content.flatMap(source => {
      const items = itemIndex(source.site)
      return source.itemIssues.map(i => itemKey(i, items, source.target))
    }),
    ...run.configIssues.map(configKey),
    ...run.projectIssues.map(projectKey),
  ]
}

/** An item problem's key; `target` is null for the repo, so the same page on two places is matched separately. */
export function itemKey(issue: Issue, items: ReturnType<typeof itemIndex>, target: string | null = null): string {
  const item = items.get(issue.itemPath)
  const id = item ? `${item.kind}:${item.name}:${item.locale ?? ''}` : `path:${issue.itemPath}`
  // An alt problem's path carries the array index, which moves when items are
  // reordered; its asset tells two references apart, so the index is left out
  // of the key (Seer on #1758).
  const contentPath =
    issue.validator === 'altRequired' ? (issue.contentPath ?? '').replace(/\[\d+\]/g, '[]') : (issue.contentPath ?? '')
  const where =
    issue.validator === 'schema-conformance'
      ? `${contentPath}|${issue.field ?? ''}`
      : `${contentPath}|${issue.subject ?? ''}`
  return `item|${target ?? ''}|${issue.validator}|${id}|${where}`
}

export function configKey(issue: Issue): string {
  return `config|${issue.validator}|${issue.itemPath}|${issue.subject ?? ''}`
}

export function projectKey(issue: ProjectIssue): string {
  return `project|${issue.validator}|${issue.template ?? issue.path ?? ''}|${issue.field ?? ''}`
}
