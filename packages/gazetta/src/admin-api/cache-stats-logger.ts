/**
 * Periodic structured logging of `AdminCache` stats per
 * `design-cache.md` Q5.
 *
 * Cadence: 5 minutes — emits ~288 entries/day per cache instance.
 * Low log volume; fine-grained enough to spot issues. Cadence is
 * not configurable in v1 (operators with stricter monitoring needs
 * poll `/api/system/cache/stats`).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns periodic-stats-logging. Routes own
 *     on-demand snapshots; the cache provider owns counters; the
 *     logger orchestrates the timer.
 *   - DIP: depends on the `AdminCache` interface, not on a specific
 *     provider.
 *   - LSP: works with any provider that implements `stats()` (and
 *     no-ops gracefully when `stats` is absent).
 *
 * # Multi-instance discipline
 *
 * The logger runs once per admin process, against one cache instance.
 * Multi-instance deployments emit one log stream per instance —
 * operators correlate via the structured log fields (notably the
 * `instance` field that the future structured logger will inject per
 * `design-logging.md`). Cross-instance aggregation is the log
 * aggregator's job, not Gazetta's.
 */
import type { AdminCache, CacheStats } from '../cache/types.js'

/** Default cadence — 5 minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export interface StartCacheStatsLoggerOptions {
  cache: AdminCache
  /**
   * Interval between log emissions, in milliseconds. Defaults to 5
   * minutes. Tests pass a smaller value (or `0` to disable the
   * background timer entirely and drive emissions manually via
   * `tick()`).
   */
  intervalMs?: number
  /**
   * Sink for emitted log entries. Defaults to `console.log` with a
   * JSON payload — matches `design-logging.md`'s "structured JSON
   * logs" rule. Tests pass a capture function.
   */
  sink?: (entry: CacheStatsLogEntry) => void
}

export interface CacheStatsLogEntry {
  /** ISO 8601 with Z suffix; matches the audit-log convention. */
  timestamp: string
  /** Always 'info' — periodic stats are healthy operational signal. */
  level: 'info'
  /** Module namespace per design-logging.md. */
  module: 'cache.stats'
  message: string
  stats: CacheStats
}

export interface CacheStatsLogger {
  /** Stop the periodic timer (does nothing if no timer is running). */
  dispose(): void
  /**
   * Manually emit one entry. Useful for tests or for triggering an
   * extra emission ahead of a planned rollover.
   */
  tick(): Promise<void>
}

/**
 * Start the periodic logger. Returns a handle exposing `dispose()`
 * for clean shutdown (tests, hot reload, graceful exit).
 *
 * When `intervalMs` is 0, no timer is scheduled — the caller drives
 * emissions via `tick()` only. Useful in tests that need
 * deterministic emit timing without fake timers.
 */
export function startCacheStatsLogger(opts: StartCacheStatsLoggerOptions): CacheStatsLogger {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const sink = opts.sink ?? defaultSink

  async function tick(): Promise<void> {
    // stats() is optional on the contract — providers that don't
    // expose it produce a minimum-floor snapshot so the log entry
    // shape stays stable across providers.
    const stats: CacheStats = (await opts.cache.stats?.()) ?? { hits: 0, misses: 0, size: 0 }
    sink({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'cache.stats',
      message: 'cache stats',
      stats,
    })
  }

  let timer: ReturnType<typeof setInterval> | null = null
  if (intervalMs > 0) {
    timer = setInterval(() => {
      // Don't await — periodic emission must not back up if a sink
      // is slow. Swallow rejections so a transient failure on one
      // tick (e.g., provider blip) doesn't propagate to the
      // unhandled-rejection handler; the next tick fires regardless.
      tick().catch(() => undefined)
    }, intervalMs)
    // Don't keep the event loop alive solely for this timer —
    // graceful shutdown shouldn't have to remember to dispose this.
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    dispose(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    tick,
  }
}

function defaultSink(entry: CacheStatsLogEntry): void {
  // Matches design-logging.md's "structured JSON logs" rule.
  // pino integration lands when the logging foundation ships;
  // until then, stringify so log aggregators tailing stdout see
  // a parseable line.
  console.log(JSON.stringify(entry))
}
