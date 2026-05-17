/**
 * Recipe selector — maps a candidate type to the Agent A recipe file
 * the orchestrator composes onto the shared agent-a.md base.
 *
 * The Record<CandidateType, RecipeName> exhaustive shape forces a TS
 * error if a new CandidateType lands without a recipe assignment —
 * the type system catches the dispatch gap that the runtime would
 * otherwise hit at first invocation.
 *
 * See bots/review-bot/prompts/recipes/README.md for naming and
 * extension rules.
 */
import type { CandidateType } from './candidates.js'

export type RecipeName = 'tdd-first' | 'coverage-shape'

const RECIPE_BY_TYPE: Record<CandidateType, RecipeName> = {
  // Bug-class candidates: failing-test → fix is the right shape.
  correctness: 'tdd-first',
  security: 'tdd-first',
  architecture: 'tdd-first',
  types: 'tdd-first',

  // Documentation + style candidates: TDD-first today (the test
  // captures the documentation invariant or style violation). May
  // earn their own recipe later if comment-rot fixes / style-only
  // fixes consistently struggle with TDD-first.
  comments: 'tdd-first',
  style: 'tdd-first',

  // Coverage-gap candidates: TDD-first can't drive working code;
  // coverage-shape is the discipline.
  tests: 'coverage-shape',
}

export function selectRecipe(type: CandidateType): RecipeName {
  return RECIPE_BY_TYPE[type]
}
