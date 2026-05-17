import { describe, expect, it } from 'vitest'
import type { CandidateType } from '../candidates.js'
import { selectRecipe } from '../recipe-select.js'

// Tests derived from the candidate-type → recipe mapping locked in
// prompts/recipes/README.md "Available recipes" table. NOT derived
// from observing the implementation (per team-preferences rule 31).

describe('selectRecipe — locked mapping from prompts/recipes/README.md', () => {
  it('bug-class candidates select tdd-first', () => {
    expect(selectRecipe('correctness')).toBe('tdd-first')
    expect(selectRecipe('security')).toBe('tdd-first')
    expect(selectRecipe('architecture')).toBe('tdd-first')
    expect(selectRecipe('types')).toBe('tdd-first')
  })

  it('documentation + style candidates select tdd-first', () => {
    expect(selectRecipe('comments')).toBe('tdd-first')
    expect(selectRecipe('style')).toBe('tdd-first')
  })

  it('tests-class candidates select coverage-shape', () => {
    expect(selectRecipe('tests')).toBe('coverage-shape')
  })

  it('every CandidateType has a recipe assignment (exhaustive)', () => {
    // The dispatcher's Record<CandidateType, RecipeName> shape makes
    // this a compile-time check; this test pins it at runtime too as
    // a regression guard against a future refactor that introduces
    // partial typing.
    const allTypes: CandidateType[] = ['correctness', 'security', 'architecture', 'tests', 'types', 'comments', 'style']
    for (const t of allTypes) {
      const recipe = selectRecipe(t)
      expect(['tdd-first', 'coverage-shape']).toContain(recipe)
    }
  })
})
