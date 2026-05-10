/**
 * Tiny ANSI color helper. No external dep.
 *
 * Respects:
 *   - NO_COLOR env var (https://no-color.org) — disables all colors
 *   - FORCE_COLOR=1 — enables colors even when stdout isn't a TTY
 *   - GitHub Actions — always renders ANSI in workflow logs (TERM=dumb
 *     locally is the only realistic non-TTY case)
 *
 * Used by orchestrator banners + the Claude stream renderer.
 */

const ESC = '\x1b['

const enabled = (() => {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR === '1') return true
  // Default: on. GitHub Actions runners render ANSI; local terminals do too.
  // Only `TERM=dumb` (rare) suppresses; respect it.
  if (process.env.TERM === 'dumb') return false
  return true
})()

function wrap(open: string, close: string) {
  return (s: string): string => (enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s)
}

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
}
