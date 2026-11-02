/**
 * The report `gazetta validate` prints, built once from every issue the run
 * found and rendered as text, JSON or GitHub output (design-template-check.md
 * T4, T6). Schema problems are grouped by the template they break, with the
 * items that use it (`computeTemplateImpact`); everything else is "other",
 * grouped by item.
 *
 * The JSON shape is `ValidateReportSchema`; cut 3 extends it with the
 * problems the base branch already had.
 */
import { relative } from 'node:path'
import { z } from 'zod'
import { allFragmentEntries, allPageEntries, type Site } from '../site-loader.js'
import { findTemplateFile } from '../template-loader.js'
import { computeTemplateImpact } from '../validation/template-impact.js'
import type { Issue } from '../validation/types.js'
import type { ComponentEntry, FragmentManifest, InlineComponent, PageManifest } from '../types.js'
import type { ProjectIssue } from './project-checks.js'

const SeveritySchema = z.enum(['error', 'warn', 'info'])

export const ReportIssueSchema = z.object({
  validator: z.string(),
  /** After the CLI's severity mapping (`CLI_SEVERITY`). */
  severity: SeveritySchema,
  /** The validator's message, e.g. the Zod message "cta: Required". */
  message: z.string(),
  /** The component the issue is in, as its path in the item (`hero`, `cols/left`); null for the item itself. */
  component: z.string().nullable(),
  /** The field within the component's content (`cta`, `items.0.title`), when known. */
  contentPath: z.string().nullable(),
})

export const ReportItemSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
  /** The language version; null for the default one. */
  locale: z.string().nullable(),
  issues: z.array(ReportIssueSchema),
})

export const ReportTemplateSchema = z.object({
  template: z.string(),
  /** The template's entry file relative to the project root (`templates/hero/index.tsx`); null when it has none. */
  file: z.string().nullable(),
  /** Problems with the template itself: it doesn't load, or it names a missing custom field. */
  issues: z.array(ReportIssueSchema),
  /** Items whose content doesn't fit it, in the order pages then fragments, default language first. */
  items: z.array(ReportItemSchema),
})

/** A problem that belongs to no template: with an item, the site's config, or a project file. */
export const ReportOtherSchema = z.discriminatedUnion('kind', [
  ReportItemSchema,
  z.object({ kind: z.literal('site'), name: z.string(), locale: z.null(), issues: z.array(ReportIssueSchema) }),
  z.object({ kind: z.literal('file'), name: z.string(), locale: z.null(), issues: z.array(ReportIssueSchema) }),
])

export const ValidateReportSchema = z.object({
  /** Whether the run passes; matches the exit code. */
  ok: z.boolean(),
  /** Every new issue the run found, shown or not (`--severity` hides some from the lists); with `--base`, already broken ones aren't counted. */
  counts: z.object({ error: z.number().int(), warn: z.number().int(), info: z.number().int() }),
  /** One entry per template with problems, in name order. */
  templates: z.array(ReportTemplateSchema),
  other: z.array(ReportOtherSchema),
  /**
   * With `--base`: problems the base commit already had, grouped the same
   * way. They're listed but don't count toward `ok` or `counts`.
   */
  alreadyBroken: z.object({ templates: z.array(ReportTemplateSchema), other: z.array(ReportOtherSchema) }).optional(),
})

export type ValidateReport = z.infer<typeof ValidateReportSchema>
export type ReportIssue = z.infer<typeof ReportIssueSchema>
export type ReportItem = z.infer<typeof ReportItemSchema>
type Severity = z.infer<typeof SeveritySchema>

export interface BuildReportInput {
  site: Site
  projectRoot: string
  templatesDir: string
  /** The scan's issues, each on an item (`pages/home/page.fr.json`), after the CLI's severity mapping. */
  itemIssues: readonly Issue[]
  /** Issues about the site's config, on no item. */
  configIssues: readonly Issue[]
  projectIssues: readonly ProjectIssue[]
  /** Which severities `--severity` shows. */
  show: (severity: Severity) => boolean
  /** Whether warnings fail the run (`--no-warn-as-error` turns it off). */
  warnAsError: boolean
  /** With `--base`: the problems the base commit already had, listed apart and not counted. */
  alreadyBroken?: IssueLists
}

export async function buildValidateReport(input: BuildReportInput): Promise<ValidateReport> {
  const fresh = await group(input, input)
  // A run passes when nothing `--severity` shows is counted, or when nothing counted fails it.
  const { counts } = fresh
  const shown = counts.error + (input.show('warn') ? counts.warn : 0) + (input.show('info') ? counts.info : 0)
  const ok = shown === 0 || !(counts.error > 0 || (input.warnAsError && counts.warn > 0))
  const report: ValidateReport = { ok, counts, templates: fresh.templates, other: fresh.other }
  if (input.alreadyBroken) {
    const already = await group(input, input.alreadyBroken)
    report.alreadyBroken = { templates: already.templates, other: already.other }
  }
  return report
}

interface IssueLists {
  itemIssues: readonly Issue[]
  configIssues: readonly Issue[]
  projectIssues: readonly ProjectIssue[]
}

/** Group one set of issues by template and item, and count them. */
async function group(
  input: BuildReportInput,
  lists: IssueLists,
): Promise<Pick<ValidateReport, 'counts' | 'templates' | 'other'>> {
  const { site, show } = input
  const items = itemIndex(site)

  // Schema problems belong to the template of the component they're in.
  const byTemplate = new Map<string, Map<string, ReportIssue[]>>()
  const otherByItem = new Map<string, ReportIssue[]>()
  const counts = { error: 0, warn: 0, info: 0 }
  // Every issue counts; `--severity` hides content issues from the lists, while
  // config and project problems are always listed, as in text output.
  const count = (severity: Severity) => counts[severity]++
  for (const issue of lists.itemIssues) {
    count(issue.severity)
    if (!show(issue.severity)) continue
    const item = items.get(issue.itemPath)
    const template =
      issue.validator === 'schema-conformance' && item ? componentTemplate(item.manifest, issue.contentPath) : undefined
    if (template) {
      const perItem = byTemplate.get(template) ?? new Map<string, ReportIssue[]>()
      perItem.set(issue.itemPath, [...(perItem.get(issue.itemPath) ?? []), reportIssue(issue)])
      byTemplate.set(template, perItem)
    } else {
      otherByItem.set(issue.itemPath, [...(otherByItem.get(issue.itemPath) ?? []), reportIssue(issue)])
    }
  }

  const templateLevel = new Map<string, ReportIssue[]>()
  const fileLevel = new Map<string, ReportIssue[]>()
  for (const issue of lists.projectIssues) {
    count(issue.severity)
    const entry = {
      validator: issue.validator,
      severity: issue.severity,
      message: issue.message,
      component: null,
      contentPath: null,
    }
    const map = issue.template ? templateLevel : fileLevel
    const key = issue.template ?? issue.path ?? ''
    map.set(key, [...(map.get(key) ?? []), entry])
  }

  const templates: ValidateReport['templates'] = []
  for (const template of [...new Set([...byTemplate.keys(), ...templateLevel.keys()])].sort()) {
    const perItem = byTemplate.get(template) ?? new Map()
    const impact = computeTemplateImpact(site, template, path => (perItem.get(path) ?? []) as unknown as Issue[])
    const file = await findTemplateFile(input.templatesDir, template)
    templates.push({
      template,
      file: file ? relative(input.projectRoot, file) : null,
      issues: templateLevel.get(template) ?? [],
      items: impact.items
        .filter(i => i.issues.length > 0)
        .map(i => ({
          kind: i.kind,
          name: i.name,
          locale: i.locale ?? null,
          issues: i.issues as unknown as ReportIssue[],
        })),
    })
  }

  const other: ValidateReport['other'] = []
  for (const issue of lists.configIssues) count(issue.severity)
  const config = lists.configIssues.map(reportIssue)
  if (config.length > 0) other.push({ kind: 'site', name: 'site.config', locale: null, issues: config })
  for (const [path, issues] of fileLevel) other.push({ kind: 'file', name: path, locale: null, issues })
  for (const [path, item] of items) {
    const issues = otherByItem.get(path)
    if (issues) other.push({ kind: item.kind, name: item.name, locale: item.locale ?? null, issues })
  }

  return { counts, templates, other }
}

function reportIssue(issue: Issue): ReportIssue {
  return {
    validator: issue.validator,
    severity: issue.severity,
    message: issue.message,
    component: issue.contentPath || null,
    contentPath: issue.field ?? null,
  }
}

interface IndexedItem {
  kind: 'page' | 'fragment'
  name: string
  locale?: string
  manifest: PageManifest | FragmentManifest
}

/** Every page and fragment version by the item path the scanner reports, pages first, default language first. */
export function itemIndex(site: Site): Map<string, IndexedItem> {
  const out = new Map<string, IndexedItem>()
  const path = (dir: string, file: string, locale?: string) => `${dir}/${file}${locale ? `.${locale}` : ''}.json`
  for (const e of allPageEntries(site))
    out.set(path(e.page.dir, 'page', e.locale), { kind: 'page', name: e.name, locale: e.locale, manifest: e.page })
  for (const e of allFragmentEntries(site))
    out.set(path(e.fragment.dir, 'fragment', e.locale), {
      kind: 'fragment',
      name: e.name,
      locale: e.locale,
      manifest: e.fragment,
    })
  return out
}

/** The template of the component at `componentPath` (`cols/left`) in `manifest`; the item's own for none. */
function componentTemplate(manifest: PageManifest | FragmentManifest, componentPath?: string): string | undefined {
  if (!componentPath) return manifest.template
  let entries: readonly ComponentEntry[] | undefined = manifest.components
  let found: InlineComponent | undefined
  for (const name of componentPath.split('/')) {
    found = entries?.find((e): e is InlineComponent => typeof e !== 'string' && e.name === name)
    if (!found) return undefined
    entries = found.components
  }
  return found?.template
}
