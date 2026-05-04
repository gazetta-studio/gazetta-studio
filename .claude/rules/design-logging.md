---
paths:
  - "packages/gazetta/src/**"
  - "apps/admin/src/**"
  - "**/log*"
  - "**/logger*"
---

# Logging — reference

Operational logging conventions for Gazetta. **Reference doc, NOT a foundational dimension.** Captures the conventions; pattern is set once, not a recurring concern in every feature design (per `feature-design-process.md`'s reference-doc category).

**Status**: design pass complete (2026-05). Implementation pending — Tier 3.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **logging discipline** every new feature follows
- [`design-audit.md`](design-audit.md) — audit log is the **forensic record** (structured events with retention); logging is the **operational signal** (what's the system doing right now)

## Logging vs. audit (the load-bearing distinction)

| Concern | Tool | Use case | Example |
|---|---|---|---|
| **What happened (forensic)?** | Audit log | Compliance, security investigation | "Alice published prod at T1; replay attempt at T3" |
| **What's the system doing (operational)?** | Logs | Debugging, monitoring, alerting | "Cache miss for pages:summary; recompute took 42ms" |

Audit is durable, structured, with retention; reads via `query()`. Logs are stream-of-events; read via log aggregators (Datadog, Splunk, journalctl).

Both share timestamp + actor concepts but the queries differ. They co-exist; consumers choose the right tool.

## Log levels (locked)

Five levels matching the standard `pino` / `winston` / `bunyan` hierarchy:

| Level | Use case | Production default |
|---|---|---|
| `trace` | Highly detailed diagnostic; inner-loop step-through | Off |
| `debug` | Diagnostic info useful for development | Off in production; on in dev |
| `info` | Normal operational events ("server started"; "cache provider initialized") | On |
| `warn` | Degraded operation; recoverable failures | On |
| `error` | Failure requiring attention | On |

**Per `gazetta.config.ts admin.logLevel`**: operator sets minimum level. `info` default.

**No `fatal` level** — Gazetta uses `error` for terminal failures + process exit. Avoids the "what's the difference between error and fatal?" decision tree.

## Structured logging (mandatory)

All logs are structured JSON, not free-text strings. Fields:

```ts
interface LogEntry {
  timestamp: string                     // ISO 8601 with Z
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  message: string                       // human-readable; one-line
  // Operational context
  module: string                        // e.g., 'admin-api', 'cache.redis', 'plugin.slack-notify'
  requestId?: string                    // correlation ID; matches design-audit.md's requestId
  // Domain context (optional, when relevant)
  scope?: { kind: string; name?: string }
  actor?: { id: string }                // recorded ONLY when operationally relevant; NOT for every log
  // Operation-specific fields (no PII; see Privacy)
  err?: { name: string; message: string; stack?: string }
  durationMs?: number
  [key: string]: unknown                // structured extras
}
```

**Why structured**: log aggregators index JSON fields; ad-hoc string parsing is fragile. `pino` / `bunyan` / `winston` all default to JSON output for production.

**No `console.log` in production code.** Use the structured logger. `console.log` allowed for development scaffolding but caught by CI lint before merge.

## Module naming convention

`module` field uses dot-separated namespace: `domain.subdomain`:

| Module | Examples |
|---|---|
| `admin-api` | `admin-api`, `admin-api.routes.pages`, `admin-api.middleware.auth` |
| `renderer` | `renderer`, `renderer.compose`, `renderer.serve` |
| `cache.{provider}` | `cache.memory`, `cache.redis`, `cache.azure` |
| `audit.{provider}` | `audit.history`, `audit.cloudwatch` |
| `auth.{trust-mode}` | `auth.cloudflare-access`, `auth.azure-easy-auth` |
| `storage.{provider}` | `storage.filesystem`, `storage.r2`, `storage.s3` |
| `plugin.{plugin-name}` | `plugin.@gazetta/slack-notify`, `plugin.local-webhook` |
| `cli` | `cli`, `cli.publish`, `cli.validate` |

Operators filter logs by module prefix (`module:cache.*` for all cache logs).

## Correlation (`requestId`)

`requestId` ties together log entries from one request. Origin:
- Worker generates UUID at request entry
- Threaded to origin via `X-Request-Id` header
- Origin handlers + sub-services tag log entries with the same `requestId`

Per `design-audit.md` Q5 lock: audit events use the same `requestId`. Logs and audit events from the same request correlate.

When operators investigate "why did Alice's save fail?", they search audit log for the failure event, get the `requestId`, then grep logs for that ID — full trace.

## Privacy (locked rules)

Per Universal Provider Requirement #3 + audit's privacy posture:

**Never in logs**:
- Authentication tokens, cookies, session IDs, API keys
- Manifest content (could contain PII; logs are operational, not content storage)
- Comment bodies (could contain PII)
- Asset bytes (binary data; logs are text)
- Email addresses by default (operator opts in via `admin.logging.recordPii: true`)

**Allowed in logs**:
- `actor.id` (matches audit's `actor.id` shape; pseudonymizable per audit Q2)
- `requestId`, `module`, `durationMs`
- HTTP method + path (non-PII)
- HTTP status code
- Error messages (sanitized — no PII strings interpolated by application code)

**Failure-log payload exclusion** (matches `design-audit.md` Q3 fail-open):

When audit recording fails (per `design-audit.md` Q3), the failure log entry MUST NOT contain the event payload. Same rule applies to other providers (cache, storage, AI alt-text): failure logs record provider name + error category, NOT the payload that failed.

## Multi-instance correlation

Logs from multiple admin instances (Cloud Run / Kubernetes deployments) merge in the log aggregator. Each entry carries:

- `instance` — instance identifier (Kubernetes pod name, Cloud Run revision, etc.; sourced from env)
- `requestId` — request-correlation across instances when the request bounces (worker → origin)

Operators searching `module:cache.* AND instance:pod-abc-123` see one instance's cache behavior; without `instance` filter, see all instances merged.

`instance` is set automatically from environment:
- Cloud Run: `K_REVISION` env
- Kubernetes: `HOSTNAME` env
- Otherwise: `os.hostname()` fallback

## Logger interface

```ts
interface Logger {
  trace(obj: object | string, msg?: string): void
  debug(obj: object | string, msg?: string): void
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
  /** Returns a child logger with the given module/context fields baked in. */
  child(bindings: { module?: string; [key: string]: unknown }): Logger
}
```

Match for `pino`'s API — Gazetta's recommended logger implementation.

**Module-scoped child loggers**: each module gets a child logger with its `module` field bound. Eliminates passing module name on every call:

```ts
// In packages/gazetta/src/cache/memory.ts
import { createLogger } from 'gazetta/logging'

const log = createLogger().child({ module: 'cache.memory' })

export class MemoryCache implements AdminCache {
  async get<T>(key: string): Promise<T | null> {
    const result = this.map.get(key)
    if (!result) {
      log.debug({ key }, 'cache miss')
      return null
    }
    log.debug({ key, ageMs: Date.now() - result.setAt }, 'cache hit')
    return result.value as T
  }
}
```

## Plugin logging (per-plugin scope)

Plugin authors get a `PluginLogger` scoped to their plugin (per `design-plugins.md` Q3 — `PluginAPI.log`):

```ts
// In a plugin
init(api: PluginAPI) {
  api.log.info('Plugin initialized')
  // Logs: { module: 'plugin.@gazetta/slack-notify', message: 'Plugin initialized', ... }
}
```

Plugin's `module` automatically prefixed; plugin author can't override the prefix (prevents impersonation of core modules).

## Implementation: `pino` recommended

`pino` is the recommended logger:
- Industry standard for Node.js structured logging
- Fast (zero-allocation hot path)
- Stable; well-maintained
- Ecosystem (transports for Datadog, Loki, etc.)

Operator config:

```ts
admin: {
  logLevel: 'info',                 // matches gazetta.config.ts global default
  logging: {
    pretty: false,                  // dev: true uses pino-pretty for human-readable
    recordPii: false,               // GDPR — operator opt-in for PII in logs
  },
}
```

Production logs to stdout (standard pattern; aggregators tail stdout). Dev mode pipes through `pino-pretty` for human-readable colored output.

## Per-instance log lifecycle

- **Process start**: `info` — "Gazetta admin started; version X.Y.Z; instance ID; module list loaded"
- **Per-request**: `info` for each request method/path/status/durationMs
- **Plugin init**: `info` per plugin
- **Errors**: `error` with stack trace
- **Process shutdown**: `info` — "Shutting down; flushing pending logs"

Logs flush before process exit (pino's `flush()` or equivalent).

## Log retention

Logs are NOT retained by Gazetta — operator's log aggregator handles retention.

If operator runs without an aggregator (single-server deployment with stdout-to-disk), they configure log rotation via systemd / logrotate / Docker logging driver. Gazetta documents the recommended setup in `docs/self-hosted.md` but doesn't ship a log-rotation primitive.

## Plugin promotion: log transport providers

`pino` has a transport ecosystem (`@pino/transport-loki`, `@pino/transport-datadog`, etc.). Plugin authors can ship Gazetta-specific log destinations as wrappers, but most operators wire `pino` transports directly via `gazetta.config.ts` rather than going through a Gazetta extension surface.

If concrete demand surfaces for "log destination as a Gazetta plugin," a `LoggingTransport` provider extension could ship — but for v1, operator wires their own pino transport. Not a foundational concern.

## Logging vs. audit checklist

When deciding whether something belongs in audit or logs:

| Situation | Use audit | Use logs |
|---|---|---|
| Compliance / security investigation | ✓ | |
| Forensic "what did Alice do" query | ✓ | |
| Long-term retention required | ✓ | |
| Operational debugging "why is this slow" | | ✓ |
| Real-time monitoring / alerting | | ✓ |
| Performance metrics (durationMs, etc.) | | ✓ |
| Authentication failure (forensic) | ✓ | |
| Authentication failure (debug operator) | | ✓ (in addition to audit) |
| Cache hit/miss | | ✓ |
| Save event | ✓ | ✓ (debug) |
| Plugin init | | ✓ |
| Plugin firing (a hook executed) | ✓ | ✓ (debug) |

Many events log AND audit. Audit is the durable record; logs are the operational stream. Both have value; both run.

## Future directions

- **Log destination provider** — operator demand for Gazetta-managed log destinations (vs. operator-wired pino transports)
- **Log sampling** — high-volume sites; opt-in sampling at debug level
- **Trace context propagation** — OpenTelemetry trace IDs alongside requestId for distributed tracing
- **Per-module log level overrides** — `admin.logging.modules: { 'cache.*': 'debug' }` for targeted debugging without flooding
