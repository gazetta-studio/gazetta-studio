/**
 * discovery-prep-bot must not research design-passed work. The collision
 * this guards: its input (enhancement, minus ready-for-human /
 * ready-for-agent / wontfix / needs-info) also matches cut-planner's planner
 * issues and any cut handed back in `needs-refinement`. Researching one
 * applies `ready-for-human`, which removes it from cut-planner's queue and
 * silently stalls the feature.
 */
import { describe, expect, it } from 'vitest'
import { renderCutBody } from '../../cut-planner/cut-body.js'
import { isDesignPassedWork } from '../design-passed.js'

describe('isDesignPassedWork', () => {
  it.each([
    ['a cut-planner planner issue', '**Feature**: rw\n**Design**: d.md\n\n## State\n\nNext: cut 1'],
    ['a pre-cut-planner tracking issue', '**Feature**: rw\n\n- [ ] #1'],
  ])('skips %s', (_l, body) => {
    expect(isDesignPassedWork(body)).toBe(true)
  })

  it('skips a cut exactly as cut-planner renders it (the needs-refinement case)', () => {
    // Pinned against the real renderer so a front-matter format change in
    // cut-planner can't silently re-open the collision.
    const body = renderCutBody({
      feature: 'rw',
      designPath: 'd.md',
      spec: 's',
      acceptance: ['a'],
      tests: ['t'],
      runId: '1',
    })
    expect(isDesignPassedWork(body)).toBe(true)
  })

  it.each([
    ['an ordinary feature request', 'It would be great to have dark mode.'],
    ['prose that merely mentions the word', 'The Feature: field is confusing in the docs.'],
    ['an empty front-matter field', '**Feature**:\n\nsomething'],
    ['an empty body', ''],
  ])('still researches %s', (_l, body) => {
    expect(isDesignPassedWork(body)).toBe(false)
  })
})
