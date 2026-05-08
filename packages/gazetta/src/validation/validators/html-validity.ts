/**
 * html-validity validator (Validation Cut 3).
 *
 * Runs html-validate (https://html-validate.org/) against the rendered output
 * of each page, surfacing structural HTML problems: missing required
 * attributes, mis-nesting, unclosed tags, deprecated elements.
 *
 * Stages: background + pre-publish + cli (NOT save-delta — depends on
 * rendered output, which save-delta doesn't have access to). Pre-publish
 * promotes warns to errors via the standard severity-promotion mechanism;
 * background surfaces them as warns to keep accumulated debt non-blocking.
 *
 * Rendered output is supplied via `input.renderedOutput` (Cut 3 contract).
 * When `renderedOutput` is absent (e.g., a save-delta scope or a setup that
 * doesn't render), the validator returns no issues — it can't analyze HTML
 * it doesn't have.
 *
 * # SOLID lenses
 *
 * - SRP: this validator owns the HTML-validity check. Render-for-analysis
 *   produces the bytes; the validator consumes them.
 * - DIP: depends on `RenderedOutputAccess` interface, not the renderer.
 * - OCP: html-validate's rule set is configurable; future operator-tunable
 *   rule subsets ship via per-site config without changing this file.
 */
import { HtmlValidate } from 'html-validate'
import type { Issue, Validator, ValidatorInput } from '../types.js'

let cachedValidator: HtmlValidate | null = null

function getValidator(): HtmlValidate {
  if (!cachedValidator) {
    cachedValidator = new HtmlValidate({
      extends: ['html-validate:recommended'],
      // Rules that fire too often on Gazetta-rendered output without adding
      // value. Kept narrow; expand only when concrete operator demand surfaces.
      rules: {
        // Allow dynamically inserted IDs (scoped CSS via hashPath).
        'no-dup-id': 'error',
      },
    })
  }
  return cachedValidator
}

export const htmlValidity: Validator = {
  source: 'gazetta',
  name: 'html-validity',
  stages: ['background', 'pre-publish', 'cli'] as const,

  defaultSeverity(stage) {
    return stage === 'pre-publish' ? 'error' : 'warn'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, renderedOutput } = input
    if (scope.kind !== 'background' && scope.kind !== 'pre-publish' && scope.kind !== 'cli') return []
    if (!renderedOutput) return []

    const items = scope.kind === 'background' ? [scope.item] : scope.kind === 'pre-publish' ? [...scope.items] : []
    if (scope.kind === 'cli') return [] // CLI scope walks the site itself; rendered output is per-item

    const issues: Issue[] = []
    const validator = getValidator()
    for (const item of items) {
      if (item.kind !== 'page') continue // fragments are partials, not full HTML
      const html = await renderedOutput.htmlFor(item)
      if (!html) continue
      const report = await validator.validateString(html)
      if (report.valid) continue
      for (const result of report.results) {
        for (const msg of result.messages) {
          issues.push({
            validator: 'html-validity',
            severity: msg.severity === 2 ? (scope.kind === 'pre-publish' ? 'error' : 'warn') : 'info',
            message: `${msg.ruleId}: ${msg.message} (line ${msg.line}, col ${msg.column})`,
            itemPath: item.itemPath,
          })
        }
      }
    }
    return issues
  },
}
