/**
 * Planner-issue parser — cut-planner's ONLY input.
 *
 * Per design-cut-planner.md Q4 (resolved open-Q 4), cut-planner never reads
 * a design doc or an implementation doc. Seeding is maintainer work: Claude
 * Code reads whichever artifact exists and writes the planner issue. That
 * keeps this parser to exactly one shape, keeps a parser for the retired
 * `-implementation.md` artifact out of bot code, and makes all features
 * migratable today rather than gating on 20 doc migrations.
 *
 * The measurement behind that lock (2026-10-04): of 32 design docs, only 4
 * have a `## Cut sequence` section; 20 still keep their cuts in a separate
 * impl doc; 8 have neither. Parsing design docs directly would mean
 * supporting three shapes, two of them deprecated.
 *
 * Shape of a planner issue body:
 *
 *   **Feature**: review-workflow
 *   **Design**: .claude/rules/design-review-workflow.md
 *
 *   ## Suggested plan
 *   | # | What | Depends on | Test tier | Risk |
 *   |---|---|---|---|---|
 *   | 5 | save-handler gates pending-review | 4 | api-first | Medium |
 *
 *   ## State
 *   Landed: cuts 1-4 (#515-#518)
 *   In flight: —
 *   Next: cut 5
 *
 *   ## Locked decisions
 *   - `invalidateOnSave` compares `computeSaveEtag(manifest)` (#837)
 *
 * Producer/consumer split per bots/README.md: this module does the
 * deterministic extraction (TS), and Claude gets the prose. So the parser
 * is deliberately shallow — it pulls the two front-matter fields and slices
 * the three sections, but does NOT try to understand the plan's rows. Row
 * semantics are Claude's job; a regex that "understood" the What column
 * would be the brittle kind of parsing rule 45's lessons warn about.
 */

export interface PlannerIssue {
  /** Feature slug from `**Feature**:`. Required. */
  feature: string
  /** Design-doc path from `**Design**:`. Required — it is the provenance for every transcribed lock. */
  designPath: string
  /** Raw `## Suggested plan` body, advisory per Q3. Empty string when absent. */
  suggestedPlan: string
  /** Raw `## State` body — cut-planner's durable per-feature memory (Q7a). */
  state: string
  /** Raw `## Locked decisions` body — the only decisions Q2 permits transcribing. */
  lockedDecisions: string
}

export type PlannerIssueParse =
  | { ok: true; value: PlannerIssue }
  /**
   * Malformed input. Per Q6a this is a FEATURE-scope escalation: the bot's
   * own input is broken, and guessing would corrupt state. `missing` names
   * the fields so the escalation comment can be specific rather than
   * telling the maintainer "it didn't parse".
   */
  | { ok: false; missing: readonly string[] }

/**
 * Extract a `**Name**: value` one-line front-matter field.
 *
 * `[^\S\n]*` rather than `\s*` for the gap: `\s` matches newlines, so with
 * `\s*(.+)` an EMPTY field silently captured the following line —
 * `**Feature**:\n**Design**: x.md` parsed as feature `"**Design**: x.md"`.
 * A half-seeded planner issue would then look valid with garbage in both
 * fields, which is worse than failing (Q6a: a broken input is a
 * feature-scope escalation, not something to guess past).
 */
function frontMatter(body: string, name: string): string | null {
  const m = body.match(new RegExp(`^\\*\\*${name}\\*\\*:[^\\S\\n]*(.+)$`, 'm'))
  const v = m?.[1]?.trim()
  return v ? v : null
}

/**
 * Slice a `## Heading` section's body, up to the next heading of the same
 * or higher level.
 *
 * Stops at `#`/`##` but NOT `###`, so a subsection inside a section stays
 * with its parent — a planner issue that grows a `### Deviations`
 * subsection under `## State` should not silently truncate.
 */
function section(body: string, heading: string): string {
  const start = body.search(new RegExp(`^##\\s+${heading}\\s*$`, 'mi'))
  if (start === -1) return ''
  const rest = body.slice(start)
  const nl = rest.indexOf('\n')
  if (nl === -1) return ''
  const after = rest.slice(nl + 1)
  const next = after.search(/^#{1,2}\s+\S/m)
  return (next === -1 ? after : after.slice(0, next)).trim()
}

/**
 * Parse a planner issue body.
 *
 * `**Feature**` and `**Design**` are required: without the slug there is
 * nothing to name cuts after, and without the design path there is no
 * provenance for the locks Q2 lets cut-planner transcribe. The three
 * sections are optional at parse time — a freshly seeded planner issue
 * legitimately has an empty `## State`, and a feature with no locked
 * decisions yet legitimately has an empty `## Locked decisions`. Whether
 * an EMPTY suggested plan means "feature done" or "seeding incomplete" is
 * a judgement for the run dispatcher (Cut 4), not the parser.
 */
export function parsePlannerIssue(body: string): PlannerIssueParse {
  const feature = frontMatter(body, 'Feature')
  const designPath = frontMatter(body, 'Design')

  const missing: string[] = []
  if (!feature) missing.push('**Feature**')
  if (!designPath) missing.push('**Design**')
  if (!feature || !designPath) return { ok: false, missing }

  return {
    ok: true,
    value: {
      feature,
      designPath,
      suggestedPlan: section(body, 'Suggested plan'),
      state: section(body, 'State'),
      lockedDecisions: section(body, 'Locked decisions'),
    },
  }
}

/**
 * Replace a `## Heading` section's body, keeping everything else verbatim.
 *
 * Uses the same boundary rule as `section()` above — a section ends at the
 * next `#`/`##` heading, so a `###` subsection stays with its parent — so a
 * read followed by a write always addresses the same span. Appends the
 * section when absent, which is how a freshly seeded planner issue with no
 * `## State` gets one on the first filing.
 *
 * Only cut-planner's own section is ever rewritten. `## Suggested plan` and
 * `## Locked decisions` are maintainer-seeded (open-Q 4) and are never passed
 * here.
 */
export function replaceSection(body: string, heading: string, content: string): string {
  const startRe = new RegExp(`^##\\s+${heading}\\s*$`, 'mi')
  const m = startRe.exec(body)
  const block = `## ${heading}\n\n${content.trim()}\n`
  if (!m) return `${body.trimEnd()}\n\n${block}`
  const headEnd = body.indexOf('\n', m.index)
  const after = headEnd === -1 ? '' : body.slice(headEnd + 1)
  const next = after.search(/^#{1,2}\s+\S/m)
  const tail = next === -1 ? '' : `\n${after.slice(next)}`
  return `${body.slice(0, m.index)}${block}${tail}`
}
