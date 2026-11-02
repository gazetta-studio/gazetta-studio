/**
 * `gazetta validate --targets a,b`: the named targets' storage, built from
 * `site.config.ts` as `gazetta publish` builds it (design-template-check.md
 * T5, T10, T11, #1754). Every name is checked before any check runs, and
 * none is ever skipped: an unknown name, a public target (it holds no
 * manifests, `design-public-storage.md` Q4) or a target that can't be read
 * refuses the run, and `gazetta validate` exits 2.
 */
import { getType, isPublicStorage, type StorageProvider, type TargetConfig } from '../types.js'
import type { TargetSource } from './validate-run.js'

export class TargetRefusal extends Error {}

/** `production,staging` → `['production', 'staging']`, without blanks or repeats. */
export function parseTargetList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ),
  ]
}

export async function resolveTargets(
  names: readonly string[],
  targetConfigs: Record<string, TargetConfig>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<TargetSource[]> {
  const configured = Object.keys(targetConfigs)
  // `--targets ""` or `--targets ,` names nothing: refuse rather than check only the repo (Seer on #1757).
  if (names.length === 0) throw new TargetRefusal(`\`--targets\` names no target. Targets: ${configured.join(', ')}.`)
  for (const name of names) {
    if (!targetConfigs[name]) throw new TargetRefusal(`No target named \`${name}\`. Targets: ${configured.join(', ')}.`)
    if (isPublicStorage(targetConfigs[name]))
      throw new TargetRefusal(`\`${name}\` is public storage, which holds no manifests. Remove it from \`--targets\`.`)
  }
  const sources: TargetSource[] = []
  for (const name of names) {
    const storage = targetConfigs[name].storage
    try {
      await probeWithTimeout(storage, timeoutMs)
    } catch (err) {
      throw new TargetRefusal(`Couldn't read target \`${name}\`: ${(err as Error).message}`)
    }
    sources.push({ name, storage, static: getType(targetConfigs[name]) === 'static' })
  }
  return sources
}

/** How long a target may take to answer before the run is refused, as at admin boot (`targets.ts`). */
export const PROBE_TIMEOUT_MS = 10_000

/** `probe` with a time limit: an SDK that never answers refuses the run instead of hanging it (Seer on #1757). */
async function probeWithTimeout(storage: StorageProvider, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${timeoutMs / 1000} s`)), timeoutMs)
  })
  try {
    await Promise.race([probe(storage), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Connect (S3 and Azure probe there) and list what holds the manifests, so a missing credential fails now. */
async function probe(storage: StorageProvider): Promise<void> {
  const init = (storage as StorageProvider & { init?: () => Promise<void> }).init
  if (typeof init === 'function') await init.call(storage)
  for (const root of ['pages', 'fragments']) {
    if (await storage.exists(root)) await storage.readDir(root)
  }
}
