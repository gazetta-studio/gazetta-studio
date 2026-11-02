/**
 * Argument parser for `gazetta validate` (Validation Cut 5).
 *
 * Per design-validation-implementation.md Cut 5 — extracted as its own
 * module so the parser is unit-testable without running the CLI entry
 * point's `main()`.
 *
 * Flags:
 *   --severity error|warn|all  (default: error)
 *   --include-quality          (default: off — a11y + html-validity skipped)
 *   --no-warn-as-error         (default: on — warns fail the run)
 *   --verbose / -v             (default: off — errors only under each item)
 *   --json, --format json|github|text  (default: text)
 */

export interface ValidateOptions {
  /** Output filter — which severities to display + count toward exit code. */
  severity: 'error' | 'warn' | 'all'
  /** When true, run accessibility + html-validity validators (require rendering). */
  includeQuality: boolean
  /** When true, warn-severity issues exit non-zero. Default true. */
  warnAsError: boolean
  /** When true, also list warnings and info under each item; errors are always listed. */
  verbose: boolean
  /** How the report is printed: text for a terminal, one JSON document, or a GitHub job summary and annotations. */
  format: 'text' | 'json' | 'github'
}

/**
 * Parse `gazetta validate` flags from raw CLI args. Unknown flags pass
 * through silently — same posture as the existing `parseArgs`.
 */
export function parseValidateFlags(rawArgs: readonly string[]): ValidateOptions {
  const opts: ValidateOptions = {
    severity: 'error',
    includeQuality: false,
    warnAsError: true,
    verbose: false,
    format: 'text',
  }
  const asFormat = (v: string | undefined) => (v === 'text' || v === 'json' || v === 'github' ? v : undefined)
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--severity') {
      const next = rawArgs[++i]
      if (next === 'error' || next === 'warn' || next === 'all') opts.severity = next
    } else if (a.startsWith('--severity=')) {
      const v = a.slice('--severity='.length)
      if (v === 'error' || v === 'warn' || v === 'all') opts.severity = v
    } else if (a === '--include-quality') {
      opts.includeQuality = true
    } else if (a === '--no-warn-as-error') {
      opts.warnAsError = false
    } else if (a === '--verbose' || a === '-v') {
      opts.verbose = true
    } else if (a === '--json') {
      opts.format = 'json'
    } else if (a === '--format') {
      opts.format = asFormat(rawArgs[++i]) ?? opts.format
    } else if (a.startsWith('--format=')) {
      opts.format = asFormat(a.slice('--format='.length)) ?? opts.format
    }
  }
  return opts
}
