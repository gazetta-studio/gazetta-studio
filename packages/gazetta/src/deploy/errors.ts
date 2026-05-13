/**
 * Error taxonomy for the DeployAdapter Pattern 1 Provider surface.
 *
 * Cut 1 of the deploy contract. Per ADR-0004 Universal Provider
 * Requirement #6 ("independent error taxonomy"), every Provider
 * surface declares its own error classes for runtime branching.
 *
 * Adapters translate platform-SDK errors into these classes; the CLI
 * catches `DeployError` and surfaces the `adapter` field plus a
 * human-readable message. Debug logs include the underlying cause.
 *
 * Reference: `.claude/rules/design-deploy.md` "Error taxonomy" section.
 */

/**
 * Base class for all deploy errors. Carries the adapter name so the
 * CLI can surface "Cloudflare Workers deploy failed: ..." instead of
 * a context-free error message.
 */
export class DeployError extends Error {
  public readonly adapter: string

  constructor(message: string, adapter: string) {
    super(message)
    this.name = 'DeployError'
    this.adapter = adapter
  }
}

/**
 * Raised at factory construction (synchronous) when operator-supplied
 * options are missing required fields or malformed. Surfaces in the
 * IDE / at admin boot, not at deploy time.
 *
 * Example: `cloudflareWorkersDeploy({ name: 'foo' })` without
 * `apiToken` throws `DeployConfigError` because the platform SDK
 * can't proceed without credentials.
 */
export class DeployConfigError extends DeployError {
  constructor(message: string, adapter: string) {
    super(message, adapter)
    this.name = 'DeployConfigError'
  }
}

/**
 * Raised at `execute()` time when the platform rejects credentials.
 * Adapters wrap platform-SDK auth failures (401 / 403 from the
 * platform's API) in this class so operators see a consistent
 * "credentials rejected" surface regardless of which platform.
 */
export class DeployAuthError extends DeployError {
  constructor(message: string, adapter: string) {
    super(message, adapter)
    this.name = 'DeployAuthError'
  }
}

/**
 * Raised at `execute()` time when the network or platform SDK call
 * fails for transport reasons (timeout, DNS, 5xx from platform,
 * unexpected protocol error). Distinct from auth failures because
 * the operator's remediation differs: auth = check credentials;
 * transport = retry or investigate platform status.
 */
export class DeployTransportError extends DeployError {
  constructor(message: string, adapter: string) {
    super(message, adapter)
    this.name = 'DeployTransportError'
  }
}

/**
 * Raised at `execute()` time when the adapter expects published
 * content (e.g., a static-host adapter that reads from
 * `target.storage`) but storage is empty.
 *
 * Per Q4 lock: the CLI doesn't gate on prior publish — adapters that
 * need bytes surface this error themselves. Operator's remediation
 * is `gazetta publish <target>` before retrying `gazetta deploy`.
 */
export class DeployContentError extends DeployError {
  constructor(message: string, adapter: string) {
    super(message, adapter)
    this.name = 'DeployContentError'
  }
}
