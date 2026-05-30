/**
 * Cut-sub-issue body parser + validator — Cut 2 of feature-bot.
 *
 * Per design-feature-bot.md Q2 (just-markdown body shape) + Q3 (dependency
 * mechanism: regex-parse `**Depends on**:` with cron-tick validation) +
 * Cut 5 refinement (four sections: Spec / Acceptance / SOLID / Tests;
 * SOLID conditional).
 *
 * Pure module — no Octokit / GitHub queries. Cron-tick validation of
 * referenced issue numbers (does #501 exist? is it a cut sub-issue?
 * not closed-merged?) lives in the orchestrator (Cut 3) — those checks
 * need GitHub queries this parser deliberately avoids.
 *
 * Why split parse + validate from the orchestrator:
 *   - SRP: this module owns "interpret the cut sub-issue body";
 *     orchestrator owns "validate refs against the live issue tree
 *     + take action."
 *   - Testability: the parser + structural validator are pure
 *     functions over a string + a number; unit-testable without
 *     mocking Octokit.
 *   - Symmetric audit (rule 38): bots that grow similar shapes can
 *     copy this pattern; the structural-vs-network split is the
 *     cargo-cult-able piece.
 */

/** Result of parsing a cut sub-issue body. */
export interface ParsedCut {
  /** Feature slug from `**Feature**: <slug>` line. Null if missing. */
  feature: string | null
  /** Issue numbers from `**Depends on**: #N, #M` line. Empty array if "none", empty, or missing line. */
  dependsOn: readonly number[]
  /** Raw body for the `## Spec` section; missing → undefined. */
  spec: string | undefined
  /** Raw body for the `## Acceptance` section; missing → undefined. */
  acceptance: string | undefined
  /** Raw body for the `## SOLID` section; missing → undefined. Conditionally required (see validator). */
  solid: string | undefined
  /** Raw body for the `## Tests` section; missing → undefined. */
  tests: string | undefined
}

/**
 * Validation error categorized by failure mode. Orchestrator uses
 * this to format the loud-fail comment per Q3 + Q6.
 *
 * `not-found` and `not-a-cut` reasons are NOT emitted by
 * `validateParsedCut` — they require GitHub queries. Orchestrator
 * threads them through this same error shape after looking up refs
 * against the live issue tree (Cut 3 work).
 */
export type ValidationError =
  | { kind: 'missing-feature' }
  | { kind: 'invalid-dep-ref'; depNumber: number; reason: 'not-found' | 'not-a-cut' | 'self-reference' }
  | { kind: 'missing-required-section'; section: 'spec' | 'acceptance' | 'tests' }

/**
 * Parse a cut sub-issue body into typed fields.
 *
 * Conservative parser: never throws. Missing fields return null /
 * undefined / empty array so the validator can surface them
 * structurally rather than the parser bailing out.
 *
 * Locked behavior per Q2 + Q3 + Cut 5:
 *
 * - `**Feature**: <slug>` — one regex against the whole body
 *   (multiline). Captured text is trimmed.
 * - `**Depends on**: <text>` — same approach. Captured text is
 *   scanned for `#N` tokens; "none" / empty / missing line ALL
 *   resolve to an empty `dependsOn` array (NOT an error). Cuts
 *   with no deps are common.
 * - Section parsing — split on lines beginning `## `, match heading
 *   case-insensitively against the four recognized names. The
 *   section body is the prose between that heading and the next
 *   `## ` or end-of-string, trimmed. Non-recognized headings
 *   (`## Notes`, `## Implementation Notes`, etc.) are silently
 *   dropped — the orchestrator doesn't pass them to Agent A.
 */
export function parseCutBody(body: string): ParsedCut {
  const feature = parseFeature(body)
  const dependsOn = parseDependsOn(body)
  const sections = parseSections(body)

  return {
    feature,
    dependsOn,
    spec: sections.spec,
    acceptance: sections.acceptance,
    solid: sections.solid,
    tests: sections.tests,
  }
}

function parseFeature(body: string): string | null {
  const match = body.match(/^\*\*Feature\*\*:\s*(.+)$/m)
  if (!match) return null
  const slug = match[1].trim()
  return slug.length === 0 ? null : slug
}

function parseDependsOn(body: string): readonly number[] {
  const match = body.match(/^\*\*Depends on\*\*:\s*(.*)$/m)
  if (!match) return []
  const captured = match[1].trim()
  if (captured.length === 0) return []
  if (captured.toLowerCase() === 'none') return []
  const numbers: number[] = []
  for (const ref of captured.matchAll(/#(\d+)/g)) {
    numbers.push(Number(ref[1]))
  }
  return numbers
}

interface ParsedSections {
  spec: string | undefined
  acceptance: string | undefined
  solid: string | undefined
  tests: string | undefined
}

/**
 * The four recognized H2 headings. Matching is case-insensitive
 * (Q2's lock allows `## spec` and `## SPEC` to parse identically).
 * Unrecognized headings are silently dropped.
 */
const RECOGNIZED_HEADINGS: Record<string, keyof ParsedSections> = {
  spec: 'spec',
  acceptance: 'acceptance',
  solid: 'solid',
  tests: 'tests',
}

function parseSections(body: string): ParsedSections {
  const result: ParsedSections = {
    spec: undefined,
    acceptance: undefined,
    solid: undefined,
    tests: undefined,
  }

  // Walk the body line by line. When we hit `## Heading`, capture
  // the lines that follow up to the next `## ` or end-of-string.
  // Splitting on `/^## /m` and matching the first token would be
  // terser but loses the heading text + body separation; this
  // iterative shape is the readable form.
  const lines = body.split('\n')
  let currentField: keyof ParsedSections | null = null
  let currentBuffer: string[] = []

  const flush = (): void => {
    if (currentField === null) return
    const text = currentBuffer.join('\n').trim()
    // Only write when we haven't already captured this section.
    // (If a body had duplicate `## Spec` headings, the first wins;
    // the parser doesn't try to be cleverer than the documented
    // convention.)
    if (result[currentField] === undefined) {
      result[currentField] = text
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^## (.+)$/)
    if (headingMatch) {
      flush()
      const headingText = headingMatch[1].trim().toLowerCase()
      const field = RECOGNIZED_HEADINGS[headingText]
      if (field) {
        currentField = field
        currentBuffer = []
      } else {
        // Unrecognized heading — drop the section.
        currentField = null
        currentBuffer = []
      }
    } else if (currentField !== null) {
      currentBuffer.push(line)
    }
  }
  flush()

  return result
}

/**
 * Pure-TS structural validation of a parsed cut body.
 *
 * Does NOT detect `not-found` or `not-a-cut` — those need GitHub
 * queries; the orchestrator handles validation against the live
 * issue tree.
 *
 * Detects:
 * - `missing-feature` — `**Feature**:` line absent or empty
 * - `missing-required-section` — Spec / Acceptance / Tests absent
 *   (SOLID is conditional per Q6 lock; never an error here)
 * - `invalid-dep-ref` with `reason: 'self-reference'` — when
 *   `ownIssueNumber` is supplied and the dep list contains it
 *
 * @param parsed   The parsed body, from `parseCutBody`.
 * @param ownIssueNumber  Optional — the issue number of the cut
 *   sub-issue itself. When supplied, the validator emits
 *   self-reference errors. Threaded through by the orchestrator
 *   per-cut at cron-tick time (Cut 3 work).
 */
export function validateParsedCut(parsed: ParsedCut, ownIssueNumber?: number): readonly ValidationError[] {
  const errors: ValidationError[] = []

  if (parsed.feature === null) {
    errors.push({ kind: 'missing-feature' })
  }

  // Spec / Acceptance / Tests are always required.
  // SOLID is conditionally required (Q6 lock) — the validator
  // returns it as absent but does NOT raise an error. Agent A's
  // "fail-loud-on-vague-spec" path handles the judgment of
  // whether SOLID was needed for THIS cut.
  if (parsed.spec === undefined) {
    errors.push({ kind: 'missing-required-section', section: 'spec' })
  }
  if (parsed.acceptance === undefined) {
    errors.push({ kind: 'missing-required-section', section: 'acceptance' })
  }
  if (parsed.tests === undefined) {
    errors.push({ kind: 'missing-required-section', section: 'tests' })
  }

  if (ownIssueNumber !== undefined) {
    for (const dep of parsed.dependsOn) {
      if (dep === ownIssueNumber) {
        errors.push({ kind: 'invalid-dep-ref', depNumber: dep, reason: 'self-reference' })
      }
    }
  }

  return errors
}
