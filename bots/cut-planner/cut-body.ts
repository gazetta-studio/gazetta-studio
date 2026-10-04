/**
 * Cut-body renderer — composes the sub-issue feature-bot will implement.
 *
 * The output contract is not ours: it is `bots/_lib/cut-parser.ts`, which
 * feature-bot's pre-Claude `validateCutSubIssue` gate runs on every
 * candidate. `## Spec`, `## Acceptance` and `## Tests` are REQUIRED there;
 * `## SOLID` is conditional (required for cuts introducing interfaces,
 * module boundaries or abstractions — optional for pure-data-shape or
 * pure-docs cuts). A body this module emits that fails that parser would
 * be filed and then immediately bounced, so the tests assert against the
 * real parser rather than against a local idea of the shape.
 *
 * What goes IN the body matters as much as the sections. Per
 * design-cut-planner.md Q2, a cut body carries functional requirements AND
 * technical suggestions — but every technical suggestion must trace to a
 * decision already locked in the design doc. cut-planner transcribes
 * locks; it never invents them.
 *
 * #519 is the worked example in both directions. Its original body said
 * "Resolve open-Q #2 here" — a functional requirement with an unresolved
 * design decision embedded in it, which made Agent A *decide* before it
 * could *build*, and the cut failed three times. Its rewrite states the
 * locked contract and names the concrete target file. The difference is
 * entirely whether the decision existed before the cut was specified.
 */

export interface CutBodyInput {
  /** Feature slug, from the planner issue's `**Feature**:`. */
  feature: string
  /** Design-doc path — provenance for every transcribed lock. */
  designPath: string
  /** Narrative: what to build. Claude-authored. */
  spec: string
  /** Testable outcomes, one per line (without bullet markers). */
  acceptance: readonly string[]
  /** Specific test files + the behaviour they pin. */
  tests: readonly string[]
  /**
   * Which SOLID lenses this cut commits to. Omit for pure-data-shape or
   * pure-docs cuts where the lens genuinely does not apply — emitting an
   * empty `## SOLID` would be worse than omitting it, since a reader
   * cannot tell "N/A" from "forgotten".
   */
  solid?: string
  /**
   * Decisions transcribed verbatim from the planner issue's
   * `## Locked decisions`. Rendered into the Spec so Agent A reads them as
   * constraints rather than having to go find them.
   */
  lockedDecisions?: readonly string[]
  /** GitHub Actions run id, or 'local'. */
  runId: string
}

/** Outcome-tag marker for a cut cut-planner filed. */
export function filedCutMarker(feature: string): string {
  return `cut-planner: filed feature=${feature}`
}

function bullets(lines: readonly string[]): string {
  return lines
    .map(l => l.trim())
    .filter(l => l !== '')
    .map(l => (l.startsWith('-') ? l : `- ${l}`))
    .join('\n')
}

/**
 * Render a cut sub-issue body.
 *
 * `**Depends on**:` is deliberately emitted as `none`. Q1 removed the need
 * for it by filing one cut at a time — ordering is enforced by
 * cut-planner's own precedence (Q5a step 2 stops while a cut is in
 * flight), not by a dependency field. Emitting the field with an explicit
 * `none` rather than omitting it keeps feature-bot's regex parser on a
 * well-trodden path and tells a human reader the omission is intentional
 * rather than an oversight.
 */
export function renderCutBody(input: CutBodyInput): string {
  const locks =
    input.lockedDecisions && input.lockedDecisions.length > 0
      ? `\n**Locked decisions — do not re-decide these.** Transcribed from \`${input.designPath}\`:\n\n${bullets(input.lockedDecisions)}\n`
      : ''

  const solid = input.solid?.trim() ? `\n## SOLID\n\n${input.solid.trim()}\n` : ''

  return `**Feature**: ${input.feature}
**Depends on**: none

## Spec

${input.spec.trim()}

Design: \`${input.designPath}\`
${locks}
## Acceptance

${bullets(input.acceptance)}
${solid}
## Tests

${bullets(input.tests)}

<!-- ${filedCutMarker(input.feature)} run=${input.runId} -->`
}
