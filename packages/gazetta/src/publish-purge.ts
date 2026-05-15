import type { TargetConfig } from './types.js'

/**
 * Picks which targets are eligible for CDN cache purging after a publish.
 *
 * Why: the publish loop already filters which targets receive content
 * via `runPublish(siteDir, targetName)`. The cache-purge pass must stay
 * in sync — purging an unrelated target's CDN on a `publish local`
 * surprises operators and wastes provider API calls. Centralizing the
 * filter here keeps the two passes from drifting apart.
 */
export function selectPurgeTargets(
  targets: Record<string, TargetConfig>,
  targetName: string | undefined,
): Array<[string, TargetConfig]> {
  if (targetName === undefined) return Object.entries(targets)
  const config = targets[targetName]
  return config === undefined ? [] : [[targetName, config]]
}
