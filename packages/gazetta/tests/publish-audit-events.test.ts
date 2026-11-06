/**
 * The per-target publish event (#1799): `success` only when every item
 * reached the target, `write-failed` with the failed items otherwise.
 */
import { describe, expect, it } from 'vitest'
import { publishResultEvent, publishStartEvent } from '../src/publish-audit-events.js'

const base = { items: ['pages/home', 'fragments/header'], source: 'local' }

describe('publishResultEvent', () => {
  it('records success and names the target when every item arrived', () => {
    expect(publishResultEvent({ target: 'staging', success: true }, base)).toEqual({
      action: 'publish',
      outcome: 'success',
      scope: { kind: 'site', name: 'staging' },
      metadata: { items: base.items, target: 'staging', targets: ['staging'], source: 'local' },
    })
  })

  it.each([
    [
      'an item failed',
      { target: 't', success: true, failedItems: [{ item: 'pages/home:fr', reason: 'boom' }] },
      [{ item: 'pages/home:fr', reason: 'boom' }],
    ],
    [
      'an item was held back',
      { target: 't', success: true, notPublished: [{ item: 'pages/home', reason: 'asset gone' }] },
      [{ item: 'pages/home', reason: 'asset gone' }],
    ],
    [
      'the target failed with its items listed',
      { target: 't', success: false, error: 'all items failed', failedItems: [{ item: 'pages/home', reason: 'x' }] },
      [{ item: 'pages/home', reason: 'x' }],
    ],
    [
      'the target failed as a whole',
      { target: 't', success: false, error: 'copy failed' },
      base.items.map(item => ({ item, reason: 'copy failed' })),
    ],
  ])('records write-failed when %s', (_, result, failedItems) => {
    const ev = publishResultEvent(result, base)
    expect(ev.outcome).toBe('write-failed')
    expect(ev.metadata?.failedItems).toEqual(failedItems)
  })

  it('records write-failed for a failed target even with no items', () => {
    expect(publishResultEvent({ target: 't', success: false, error: 'No items' }, { items: [] }).outcome).toBe(
      'write-failed',
    )
  })
})

describe('publishStartEvent', () => {
  it('records success for the target before it is written', () => {
    expect(publishStartEvent('production', base)).toMatchObject({
      outcome: 'success',
      scope: { kind: 'site', name: 'production' },
    })
  })
})
