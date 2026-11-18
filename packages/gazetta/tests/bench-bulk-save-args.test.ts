import { describe, expect, it } from 'vitest'
import { parseBenchArgs } from '../scripts/bench-bulk-save-args.js'
import { BULK_SAVE_MAX_ITEMS } from '../src/admin-api/routes/saves.js'

describe('bench-bulk-save arguments', () => {
  it('defaults to a full batch the bulk save accepts', () => {
    expect(parseBenchArgs([])).toEqual({ items: BULK_SAVE_MAX_ITEMS, runs: 3, warm: true })
  })

  it('reads items, runs and cold', () => {
    expect(parseBenchArgs(['40', '5', 'cold'])).toEqual({ items: 40, runs: 5, warm: false })
  })

  it('refuses more items than the bulk save takes, naming the cap', () => {
    expect(() => parseBenchArgs([String(BULK_SAVE_MAX_ITEMS + 1)])).toThrow(String(BULK_SAVE_MAX_ITEMS))
  })

  it.each(['0', '-3', 'abc', '2.5'])('refuses items=%s', items => {
    expect(() => parseBenchArgs([items])).toThrow(/items/)
  })
})
