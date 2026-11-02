/**
 * The three ways `gazetta validate` shows its report: text for a terminal,
 * JSON for scripts, and GitHub output (a job summary and annotations) for
 * CI (design-template-check.md T4). Each takes the report as built and adds
 * nothing to it.
 */
import type { Site } from '../site-loader.js'
import type { ReportIssue, ReportItem, ValidateReport } from './validate-report.js'

type Severity = ReportIssue['severity']
type Paint = (s: string) => string
export interface Colors {
  dim: Paint
  green: Paint
  yellow: Paint
  red: Paint
  cyan: Paint
}

// ---- text ------------------------------------------------------------------

/**
 * One row per page and fragment (language versions included), with its
 * issues listed under it: errors always, the rest with `verbose`. Then the
 * templates' own problems and the summary line.
 */
export function renderText(
  report: ValidateReport,
  site: Site,
  opts: { verbose: boolean; show: (severity: Severity) => boolean },
  c: Colors,
): string {
  const { verbose } = opts
  const lines: string[] = []
  const icon = (s: Severity) => (s === 'error' ? c.red('✗') : s === 'warn' ? c.yellow('⚠') : c.cyan('ⓘ'))

  for (const entry of report.other) {
    if (entry.kind !== 'site' && entry.kind !== 'file') continue
    for (const issue of entry.issues) lines.push(`  ${icon(issue.severity)} ${issue.message}`)
  }

  const byItem = new Map<string, { issue: ReportIssue; locale: string | null }[]>()
  const add = (kind: string, name: string, locale: string | null, issues: readonly ReportIssue[]) => {
    const key = `${kind}:${name}`
    byItem.set(key, [...(byItem.get(key) ?? []), ...issues.map(issue => ({ issue, locale }))])
  }
  // The repo's items get a row each below; targets' items are listed after them (#1754).
  const targetItems: ReportItem[] = []
  const place = (item: ReportItem) =>
    item.target === null ? add(item.kind, item.name, item.locale, item.issues) : targetItems.push(item)
  for (const t of report.templates) for (const i of t.items) place(i)
  for (const o of report.other) if (o.kind === 'page' || o.kind === 'fragment') place(o)

  const row = (kind: string, name: string, label: string, count: number) => {
    const issues = byItem.get(`${kind}:${name}`) ?? []
    const worst = worstOf(issues.map(i => i.issue.severity))
    const glyph = worst === 'error' ? c.red('✗') : worst === 'warn' ? c.yellow('⚠') : worst ? c.cyan('ⓘ') : c.green('✓')
    lines.push(`  ${glyph} ${label} ${c.dim(`(${count} components)`)}`)
    for (const { issue, locale } of issues) {
      if (!verbose && issue.severity !== 'error') continue
      const where = [issue.component, locale && `language ${locale}`].filter(Boolean).join(', ')
      lines.push(`      ${icon(issue.severity)} ${issue.message}${where ? c.dim(` (${where})`) : ''}`)
    }
  }
  for (const [name, page] of site.pages) row('page', name, name, page.components?.length ?? 0)
  for (const [name, frag] of site.fragments) row('fragment', name, `@${name}`, frag.components?.length ?? 0)

  for (const item of targetItems) {
    const shown = item.issues.filter(i => verbose || i.severity === 'error')
    if (shown.length === 0) continue
    lines.push(`  ${icon(worstOf(item.issues.map(i => i.severity)) ?? 'info')} ${placeLabel(item)}`)
    for (const issue of shown) {
      const where = [issue.component, item.locale && `language ${item.locale}`].filter(Boolean).join(', ')
      lines.push(`      ${icon(issue.severity)} ${issue.message}${where ? c.dim(` (${where})`) : ''}`)
    }
    if (item.fix) lines.push(`      ${c.dim(item.fix)}`)
  }

  for (const t of report.templates) {
    for (const issue of t.issues) lines.push(`  ${icon(issue.severity)} ${issue.message}`)
  }

  // With --base: what the base commit already had, listed apart; it doesn't count.
  // The report holds only what `--severity` shows (#1763).
  const already = flatten(report.alreadyBroken)
  if (already.length > 0) {
    lines.push('', `  ${c.dim('Already broken (not caused by this change):')}`)
    for (const { where, issue } of already)
      lines.push(
        `    ${icon(issue.severity)} ${where}: ${issue.message}${issue.component ? c.dim(` (${issue.component})`) : ''}`,
      )
  }

  lines.push('')
  const parts: string[] = []
  // As before: errors always count, warnings and info only when `--severity` shows them.
  const { error } = report.counts
  const warn = opts.show('warn') ? report.counts.warn : 0
  const info = opts.show('info') ? report.counts.info : 0
  if (error > 0) parts.push(`${error} error${error > 1 ? 's' : ''}`)
  if (warn > 0) parts.push(`${warn} warning${warn > 1 ? 's' : ''}`)
  if (info > 0) parts.push(`${info} info`)
  lines.push(parts.length === 0 ? `  ${c.green('All good.')}` : `  ${parts.join(', ')}.`)
  return `${lines.join('\n')}\n`
}

// ---- JSON ------------------------------------------------------------------

export function renderJson(report: ValidateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

// ---- GitHub ----------------------------------------------------------------

/**
 * A Markdown job summary (one table per template, then the other problems)
 * and one annotation per template with problems, on its entry file.
 */
export function renderGithub(report: ValidateReport): { summary: string; annotations: string[] } {
  // Only new problems are annotated; already broken ones sit in the summary's collapsed block.
  const annotations = report.templates.flatMap(t => {
    const worst = worstOf([...t.issues, ...t.items.flatMap(i => i.issues)].map(i => i.severity))
    return worst === 'error' || worst === 'warn' ? [annotation(worst, t.template, t.file, t.issues, t.items)] : []
  })
  const already = report.alreadyBroken
  const alreadyBlock =
    already && (already.templates.length > 0 || already.other.length > 0)
      ? [
          '<details><summary>Already broken (not caused by this change)</summary>',
          '',
          ...tables(already.templates, already.other, '####'),
          '</details>',
          '',
        ]
      : []
  if (report.ok) return { summary: ['**Template check passed.**', '', ...alreadyBlock].join('\n'), annotations }

  const out = [
    `## Template check: ${countsLine(report)}`,
    '',
    ...tables(report.templates, report.other, '###'),
    ...alreadyBlock,
  ]
  return { summary: `${out.join('\n')}\n`, annotations }
}

/** A table per template, then the other problems. */
function tables(templates: ValidateReport['templates'], other: ValidateReport['other'], heading: string): string[] {
  const out: string[] = []
  for (const t of templates) {
    out.push(`${heading} \`${t.template}\`${t.file ? ` (\`${t.file}\`)` : ''}`, '')
    for (const issue of t.issues) out.push(`- ${cell(issue.message)}`)
    if (t.issues.length > 0) out.push('')
    if (t.items.length > 0) {
      out.push('| Item | Language | Field | Message |', '|---|---|---|---|')
      for (const item of t.items)
        for (const issue of item.issues)
          out.push(
            `| ${cell(placeLabel(item))} | ${item.locale ?? 'default'} | ${cell(field(issue))} | ${cell(issue.message)} |`,
          )
      out.push('')
      const fixes = [...new Set(t.items.flatMap(i => (i.fix ? [i.fix] : [])))]
      for (const fix of fixes) out.push(`- ${cell(fix)}`)
      if (fixes.length > 0) out.push('')
    }
  }
  if (other.length > 0) {
    out.push(`${heading} Other problems`, '', '| Where | Language | Message |', '|---|---|---|')
    for (const o of other)
      for (const issue of o.issues)
        out.push(
          `| ${cell(o.kind === 'page' || o.kind === 'fragment' ? placeLabel(o) : o.name)} | ${o.locale ?? (o.kind === 'page' || o.kind === 'fragment' ? 'default' : '')} | ${cell(issue.message)} |`,
        )
    out.push('')
    const fixes = [...new Set(other.flatMap(o => ('fix' in o && o.fix ? [o.fix] : [])))]
    for (const fix of fixes) out.push(`- ${cell(fix)}`)
    if (fixes.length > 0) out.push('')
  }
  return out
}

/** Every already-broken issue with a label for where it is: a template, an item, the config or a file. */
function flatten(groups: ValidateReport['alreadyBroken']): { where: string; issue: ReportIssue }[] {
  if (!groups) return []
  const label = (o: { kind: string; name: string; locale: string | null; target?: string | null }) =>
    `${itemLabel(o.kind, o.name)}${o.locale ? ` (${o.locale})` : ''}${o.target ? ` on ${o.target}` : ''}`
  return [
    ...groups.templates.flatMap(t => [
      ...t.issues.map(issue => ({ where: `template ${t.template}`, issue })),
      ...t.items.flatMap(i => i.issues.map(issue => ({ where: label(i), issue }))),
    ]),
    ...groups.other.flatMap(o => o.issues.map(issue => ({ where: label(o), issue }))),
  ]
}

const MAX_NAMED = 5

function annotation(
  severity: 'error' | 'warn',
  template: string,
  file: string | null,
  ownIssues: readonly ReportIssue[],
  items: ValidateReport['templates'][number]['items'],
): string {
  const names = items.map(i => `${placeLabel(i)}${i.locale ? ` (${i.locale})` : ''}`)
  const title =
    items.length > 0
      ? `${template} doesn't fit ${items.length} item${items.length > 1 ? 's' : ''}`
      : `${template} has a problem`
  const message = [
    ...ownIssues.map(i => i.message),
    ...(names.length > 0
      ? [
          `${names.slice(0, MAX_NAMED).join(', ')}${names.length > MAX_NAMED ? `, and ${names.length - MAX_NAMED} more` : ''}`,
        ]
      : []),
  ].join('\n')
  const props = [file ? `file=${escapeProperty(file)}` : null, `title=${escapeProperty(title)}`]
    .filter(Boolean)
    .join(',')
  return `::${severity === 'error' ? 'error' : 'warning'} ${props}::${escapeData(message)}`
}

/** Workflow command data: `%`, `\r` and `\n` are escaped. */
export function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** Workflow command property values: also `:` and `,`. */
export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

// ---- shared ----------------------------------------------------------------

/** `pages/promo`, or `pages/promo on production` for a target's item. */
function placeLabel(item: Pick<ReportItem, 'kind' | 'name' | 'target'>): string {
  return `${itemLabel(item.kind, item.name)}${item.target ? ` on ${item.target}` : ''}`
}

function itemLabel(kind: string, name: string): string {
  if (kind === 'page') return `pages/${name}`
  if (kind === 'fragment') return `@${name}`
  return name
}

function field(issue: ReportIssue): string {
  return [issue.component, issue.contentPath].filter(Boolean).join(' › ')
}

/** A table cell: no line breaks; `\\` and `|` escaped, backslash first. */
export function cell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

function worstOf(severities: readonly Severity[]): Severity | undefined {
  if (severities.includes('error')) return 'error'
  if (severities.includes('warn')) return 'warn'
  return severities.length > 0 ? 'info' : undefined
}

/** The counts the lists show: what `--severity` hides isn't listed, so it isn't counted here either. */
function shownCounts(report: ValidateReport): ValidateReport['counts'] {
  const counts = { error: 0, warn: 0, info: 0 }
  const all = [
    ...report.templates.flatMap(t => [...t.issues, ...t.items.flatMap(i => i.issues)]),
    ...report.other.flatMap(o => o.issues),
  ]
  for (const issue of all) counts[issue.severity]++
  return counts
}

function countsLine(report: ValidateReport): string {
  const { error, warn, info } = shownCounts(report)
  return [
    error && `${error} error${error > 1 ? 's' : ''}`,
    warn && `${warn} warning${warn > 1 ? 's' : ''}`,
    info && `${info} info`,
  ]
    .filter(Boolean)
    .join(', ')
}
