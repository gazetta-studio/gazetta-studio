import { BULK_SAVE_MAX_ITEMS } from '../src/admin-api/routes/saves.js'

export interface BenchArgs {
  items: number
  runs: number
  /** False for `cold`: measure a site's first write, which also records history's baseline. */
  warm: boolean
}

/** `[items] [runs] [cold]` for bench-bulk-save.ts; items defaults to the bulk save's cap. */
export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const items = Number(argv[0] ?? BULK_SAVE_MAX_ITEMS)
  if (!Number.isInteger(items) || items < 1) throw new Error(`items must be a positive integer, got ${argv[0]}`)
  if (items > BULK_SAVE_MAX_ITEMS)
    throw new Error(`items must be at most ${BULK_SAVE_MAX_ITEMS}, the bulk save's cap (design-agent-access.md Q46)`)
  return { items, runs: Number(argv[1] ?? 3), warm: argv[2] !== 'cold' }
}
