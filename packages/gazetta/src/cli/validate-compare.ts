/**
 * `gazetta validate --base`: which of the working tree's problems the base
 * commit already had (design-template-check.md T2, Open question 1, #1750).
 *
 * A head issue is already broken when a base issue has the same key; every
 * other head issue is new, and only new issues fail the run. The key is
 * everything but the message, because a schema change can reword Zod's
 * message for a field that was already broken:
 *
 * | Issue                         | Key                                                  | Example                                                        |
 * |-------------------------------|------------------------------------------------------|----------------------------------------------------------------|
 * | Schema problem                | validator, item (kind, name, language), component, field | `schema-conformance` page `home` `fr`, `hero`, `title`     |
 * | Other problem on an item      | validator, item, contentPath                         | `referenced-fragment-exists` page `about`, no contentPath      |
 * | Site config                   | validator, config path                               | `target-deploy-coverage` `site.config.ts:targets.production`   |
 * | Template or project file      | validator, template or file, field                   | `custom-field-exists` `hero` `color`; `orphaned-editor` `admin/editors/x.tsx` |
 *
 * Two head issues with one base issue's key are both already broken.
 * Items are matched by kind, name and language, not by file path: the base
 * commit's files live in another folder.
 */
import type { Issue } from '../validation/types.js'
import type { ProjectIssue } from './project-checks.js'
import { itemIndex } from './validate-report.js'
import type { RunIssues } from './validate-run.js'

export type IssueLists = Omit<RunIssues, 'site'>

export interface Comparison {
  /** Problems the base commit didn't have: they count and fail the run. */
  fresh: IssueLists
  /** Problems the base commit already had: listed, not counted. */
  alreadyBroken: IssueLists
}

export function compareRuns(head: RunIssues, base: RunIssues): Comparison {
  const baseKeys = new Set(keys(base))
  const headItems = itemIndex(head.site)
  const fresh: IssueLists = { itemIssues: [], configIssues: [], projectIssues: [] }
  const alreadyBroken: IssueLists = { itemIssues: [], configIssues: [], projectIssues: [] }
  const sort = <K extends keyof IssueLists>(list: K, issue: IssueLists[K][number], key: string) =>
    ((baseKeys.has(key) ? alreadyBroken : fresh)[list] as IssueLists[K][number][]).push(issue)
  for (const issue of head.itemIssues) sort('itemIssues', issue, itemKey(issue, headItems))
  for (const issue of head.configIssues) sort('configIssues', issue, configKey(issue))
  for (const issue of head.projectIssues) sort('projectIssues', issue, projectKey(issue))
  return { fresh, alreadyBroken }
}

function keys(run: RunIssues): string[] {
  const items = itemIndex(run.site)
  return [
    ...run.itemIssues.map(i => itemKey(i, items)),
    ...run.configIssues.map(configKey),
    ...run.projectIssues.map(projectKey),
  ]
}

export function itemKey(issue: Issue, items: ReturnType<typeof itemIndex>): string {
  const item = items.get(issue.itemPath)
  const id = item ? `${item.kind}:${item.name}:${item.locale ?? ''}` : `path:${issue.itemPath}`
  const where =
    issue.validator === 'schema-conformance'
      ? `${issue.contentPath ?? ''}|${issue.field ?? ''}`
      : `${issue.contentPath ?? ''}`
  return `item|${issue.validator}|${id}|${where}`
}

export function configKey(issue: Issue): string {
  return `config|${issue.validator}|${issue.itemPath}`
}

export function projectKey(issue: ProjectIssue): string {
  return `project|${issue.validator}|${issue.template ?? issue.path ?? ''}|${issue.field ?? ''}`
}
