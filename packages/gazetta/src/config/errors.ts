/**
 * Config-loading error types.
 *
 * Per design-config.md and Universal Provider Requirements:
 * - Configuration errors throw at admin boot (admin won't start)
 * - Errors carry the file path so operators can locate the issue
 */

/** Base class for all config-loading errors. */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

/** Schema validation failed — config doesn't match the expected shape. */
export class ConfigValidationError extends ConfigError {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: { cause?: unknown },
  ) {
    super(`${message} (in ${filePath})`, options)
    this.name = 'ConfigValidationError'
  }
}

/** Config file couldn't be parsed (syntax error, evaluation throws). */
export class ConfigEvaluationError extends ConfigError {
  constructor(
    message: string,
    public readonly filePath: string,
    options?: { cause?: unknown },
  ) {
    super(`${message} (in ${filePath})`, options)
    this.name = 'ConfigEvaluationError'
  }
}

/** Layout conflict — both flat (root site.config.ts) and sites/ dir present. */
export class ConfigLayoutError extends ConfigError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigLayoutError'
  }
}
