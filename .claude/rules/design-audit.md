---
paths:
  - "packages/gazetta/src/history-recorder.ts"
  - "packages/gazetta/src/history.ts"
  - "packages/gazetta/src/admin-api/**"
  - "**/audit*"
---

# Audit log

Foundational dimension #5 of 12. Pluggable audit-event recording with multiple provider implementations (history-extended at v1; external sinks reserved). Composes with auth/RBAC's `Principal` for actor identity and with the real-time event-source discipline (audit log = source of real-time events for presence + live publish status).

**Status**: design pass pending — sequenced after `design-auth-rbac.md`. See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Audit check** every new feature design must answer
- [`design-auth-rbac.md`](design-auth-rbac.md) — auth/RBAC primitives expose the `Principal` to handlers; audit records actions taken with it
- [`design-publishing.md`](design-publishing.md) — history-recorder is the existing primitive that audit extends
- [`design-plugins.md`](design-plugins.md) — Universal Provider requirements apply to `AuditProvider`
- [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md) — pluggable provider pattern

## Why this is foundational

Every write event (save, publish, delete, restore) needs to be recorded with an actor identity, a timestamp, and a target scope. Audit log is the durable record that:
- Compliance auditors trace
- Real-time presence + publish-status observe (per the real-time event-source discipline)
- Forensic incident response queries

Adding audit later means auditing every save/publish/delete consumer and adding actor-recording infrastructure. Joint design with auth/RBAC because audit records actor identity (which RBAC owns) and actions taken (which the capability vocabulary defines).

## Locked invariants (already decided)

- **`AuditProvider` is Extension Surface #11.** Per [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md). Universal Provider requirements per [`design-plugins.md`](design-plugins.md) "Universal Provider requirements."
- **history-recorder is the foundation for audit log.** `recordWrite()` already runs on every save and publish ([packages/gazetta/src/history-recorder.ts](../../packages/gazetta/src/history-recorder.ts)). The audit log adds an `actor` field; doesn't replace the existing primitive.
- **Audit log is the source of real-time events.** Per the real-time event-source discipline in `feature-design-process.md`, save/publish handlers record to audit log; real-time push (presence, live publish status) observes audit log. Not bolted into save/publish handlers directly.

## Surface-specific contract

```ts
export interface AuditProvider {
  readonly name: string
  /** Record an audit event. MUST NOT throw on transport errors;
   *  fall back to local recording on failure. Audit failures never block writes
   *  (fail-open default; strict mode opt-in via admin.audit.strict: true). */
  record(event: AuditEvent): Promise<void>
  /** Optional — providers that own the storage support querying.
   *  External-sink providers can return null to indicate
   *  "query the external system directly." */
  query?(filter: AuditQuery): Promise<AuditEvent[]>
}
```

**Event shape:**

```ts
export interface AuditEvent {
  /** ISO 8601 with Z suffix; matches existing history-recorder convention. */
  timestamp: string
  /** Email when available, provider-specific subject otherwise.
   *  "unknown" for pre-RBAC revisions or trust:none deployments. */
  actor: string
  /** Narrowed enum; configure-roles records role-mapping changes
   *  in site.yaml as a special "configuration write". */
  action: 'save' | 'publish' | 'delete' | 'restore' | 'configure-roles'
  /** What was acted on. */
  scope: { kind: 'page' | 'fragment' | 'asset' | 'site'; name?: string }
  /** Optional, instance-configurable per privacy / GDPR. Default off. */
  sourceIp?: string
  /** Optional, instance-configurable. Default off. */
  userAgent?: string
  /** Provider-specific extras (publish source target, restore revision id, etc.) */
  metadata?: Record<string, unknown>
}

export interface AuditQuery {
  actor?: string
  action?: AuditEvent['action']
  scope?: { kind?: AuditEvent['scope']['kind']; name?: string }
  since?: string  // ISO timestamp
  until?: string
  limit?: number
}
```

## Providers

**v1 in-tree:**

- **`HistoryAuditProvider`** — extends existing `Revision` (in `packages/gazetta/src/history.ts`) with audit fields. Audit IS extended history.
  - Per-revision granularity (`rev-{ts}.json`); existing pattern for multi-instance correctness.
  - Pre-RBAC revisions read with synthetic `actor: "unknown"` (computed on read, not persisted).
  - Retention matches history retention (per-target configurable). Compliance-grade retention via operator opt-in `history.retention: 1000` — same primitive.

**v2 reserved (deferred, demand-driven):**

- **`FileAuditProvider`** — separate `.gazetta/audit/` log; records non-write events (reads, role changes, login attempts, hook firings, failed authorization). Compliance-tier when SOC 2 / HIPAA recording is needed.
- **`SyslogAuditProvider`** — emits to syslog (RFC 5424). Self-hosted operators with existing syslog infra.
- **`CloudWatchAuditProvider`** — emits to AWS CloudWatch Logs.
- **`AzureMonitorAuditProvider`** — emits to Azure Monitor Logs.
- **`OpenTelemetryAuditProvider`** — emits to any OTel collector.
- **`HttpWebhookAuditProvider`** — POST events to a custom HTTP endpoint.

External-sink Providers don't replace history. Operator can run `HistoryAuditProvider` as a peer for local browsable audit + external sink for tamper-evident retention.

**Plugin promotion trigger** (matching auth identity): 3+ operator requests for an unlisted provider within 6 months → either add in-tree (if mainstream) OR promote to plugin (if long-tail).

## Configuration

Zero-config default — `HistoryAuditProvider` runs automatically; no `admin.audit` block needed.

```yaml
# Single-string Provider name
admin:
  audit:
    provider: cloudwatch    # SDK reads AWS_REGION + credentials from env
    # logGroup: gazetta-audit  # optional; default shown
```

```yaml
# List form for multi-Provider compliance scenarios
admin:
  audit:
    providers:
      - history             # local copy in target storage
      - cloudwatch          # also stream to CloudWatch
    strict: false           # default; audit failures never block writes
```

**Defaults per Provider** (sensible — operator overrides only when needed):
- `history` — uses target's `.gazetta/history/`; no override needed
- `cloudwatch` — log group `gazetta-audit`
- `azure-monitor` — workspace from `AZURE_LOG_ANALYTICS_WORKSPACE_ID` env
- `syslog` — facility `local0`
- `file` — `./.gazetta/audit/`
- `opentelemetry` — endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT` env

## Recording scope (v1)

Every write event:
- `save` (page, fragment, or asset edit)
- `publish` (any target)
- `delete` (page, fragment, or asset)
- `restore` (history rollback)
- `configure-roles` (`site.yaml`'s `admin.auth.roleMapping` change — treated as a special "configuration write")

Deferred to v2 ambient log:
- Reads (every API GET)
- Hook firings
- Failed authorization attempts

## Privacy defaults

- `sourceIp` and `userAgent` recording DEFAULT OFF. Operator opts in per `admin.audit.recordSourceIp: true` / `recordUserAgent: true` with documented GDPR consideration.
- Right-to-be-forgotten: future `gazetta audit scrub --actor=alice@example.com` CLI replaces actor field with `[scrubbed-{hash}]` in existing revisions. Hash is non-reversible. Required for GDPR-compliant operators. Trigger: validation Cut 5 CLI rewrite.

## Tampering limitation

Audit log lives in target's writable storage; an admin with write access can edit revisions. v1 accepts this; external-sink Providers (v2) are the upgrade path for high-stakes operators who need tamper-evident logs. Documented as known limitation.

## Real-time observation pattern

Composes with future presence design:
- Pull-based: real-time consumer polls for new revisions since last seen ID. Multi-instance-correct (storage shared).
- File watcher as optimization where supported (filesystem provider only).
- Push-based webhooks (`HttpWebhookAuditProvider`) for operators who want low-latency external observation.

## Index sidecar pattern (reserved)

Reserved at hard-limit scale (250K+ revisions): `.gazetta/audit-index/{actor}/`, `.gazetta/audit-index/{date}/` zero-byte sidecars enabling O(1) lookups. Per-edge sidecar pattern from asset-refs. Trigger: operator hits search SLA limit.

## Foundational checks

To be filled in when this design pass formally completes. Touchpoints to address:
- Multi-instance: per-revision granularity (existing pattern). Each instance writes its own revisions to ID-keyed files; reads aggregate via `readDir`. Multi-instance-correct by construction.
- Scale: at envelope (~25K revisions over a year): grep is fine, full-scan ~50ms. At hard limit: index sidecars (above).
- Locale: events scope locale via `metadata.locale` when relevant.
- Themes: events record theme on writes (informational).
- Team: actor + scope drive forensic queries.
- Hook: hook firings record with `action: 'hook-fired'` (deferred to v2).
- Render: render-for-analysis cache misses don't audit.
- Validation: validator failures don't audit (validators are pure); save 409s do (recorded on the receiving side).
- Plugin: plugin-supplied AuditProviders inherit Universal Provider requirements.
- Cache: AdminCache misses don't audit.
- Offline: replayed write events record `metadata.replayed: true` + original-attempt timestamp.

## Migration

Sites without `admin.audit` config use `HistoryAuditProvider` automatically. Existing history records get synthetic `actor: "unknown"` on read. No data migration.

## Future directions

- **Per-API-call recording** (reads + login attempts + failed authorization). Compliance-tier; deferred until SOC 2 / HIPAA demand.
- **External sink providers** (CloudWatch, Azure Monitor, etc.). Demand-driven; in-tree on first 3 operator requests for the same provider.
- **Index sidecar** at hard-limit scale.
- **Audit log query CLI** (`gazetta audit query --actor=X --since=Y`). Lands with validation Cut 5 CLI rewrite.
- **Right-to-be-forgotten scrub CLI** (`gazetta audit scrub`). Same trigger.
- **Audit retention separate from history retention** — for compliance teams who keep audit longer than content history.
