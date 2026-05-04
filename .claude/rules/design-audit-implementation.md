---
paths:
  - "packages/gazetta/src/audit/**"
  - "packages/gazetta/src/history-recorder.ts"
  - "packages/gazetta/src/admin-api/**"
---

# Audit log — Implementation

Companion to [design-audit.md](design-audit.md). Cut sequence with risk ordering, per-cut scope, deferred items.

See [design-audit.md](design-audit.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `audit-v1` off `main` (after AuthIdentity ships per Phase 1 sequencing). **No backwards compatibility** — replaces existing history-recorder behavior; existing pre-RBAC revisions get synthetic `actor: 'unknown'` on read.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `audit/` infrastructure: types, schemas, error taxonomy | ☐ | Low | Type-only foundation |
| 2 | `AuditProvider` interface + `HistoryAuditProvider` (extends history-recorder with `actor` + `outcome` fields) | ☐ | Medium | The seam + v1 default |
| 3 | Audit-recording middleware + sync fail-open + parallel fan-out | ☐ | Medium | The dispatch layer |
| 4 | Pseudonymization (`actorPseudonym: 'sha256'` opt-in) + sourceIp / userAgent recording with trust-mode-driven extraction | ☐ | Medium | Privacy posture |
| 5 | Wire all write handlers (save / publish / delete / restore / configure-roles) to emit audit events | ☐ | Low-medium | Mechanical integration |
| 6 | Audit query endpoint `GET /api/audit` + admin drawer UI | ☐ | Medium | The visible feature |
| 7 | `queryUrl()` deep-link UX (drawer behavior matrix when `query()` is null on external sinks — even though v1 ships only history) | ☐ | Low | Forward-compat for v2 sinks |
| 8 | Retention pruner (audit retention separate from content retention) | ☐ | Medium | Background work |
| 9 | Capability gating: `read:audit-log` on `/api/audit` | ☐ | Low | RBAC integration |
| 10 | Docs + audit drawer operator guide | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: `audit/` infrastructure

**Files added:**
- `packages/gazetta/src/audit/types.ts` — `AuditEvent`, `AuditQuery`, `AuditOutcome`, `AuditAction` enums
- `packages/gazetta/src/audit/errors.ts` — `AuditError`, `AuditConfigurationError`
- `packages/gazetta/src/audit/index.ts` — barrel

**Tests:** schema parsing happy path + closed-enum rejection of unknown values

**Why first:** lowest blast radius; types only.

### Cut 2: `AuditProvider` + `HistoryAuditProvider`

**Files added:**
- `packages/gazetta/src/audit/provider.ts` — `AuditProvider` interface
- `packages/gazetta/src/audit/providers/history.ts` — `HistoryAuditProvider`; extends existing history-recorder `Revision` shape with `actor` + `outcome` fields (per design-audit.md "Locked invariants" — audit IS extended history)

**Files modified:**
- `packages/gazetta/src/history.ts` — `Revision` type extends with optional `audit` field
- `packages/gazetta/src/history-recorder.ts` — record `actor` snapshot from `Principal`

**Tests:** `HistoryAuditProvider` records every outcome (success / forbidden / validation-failed / unauthenticated) + actor snapshot fidelity + pre-RBAC revisions surface synthetic `actor: 'unknown'` on read

**Why second:** establishes the seam. History extension is additive; existing history readers ignore the new field.

### Cut 3: Audit-recording middleware

**Files added:**
- `packages/gazetta/src/audit/recorder.ts` — `recordToAll(event, providers)` with `Promise.allSettled` fan-out + failure logging (no payload in failure logs)
- `packages/gazetta/src/admin-api/middleware/audit.ts` — Hono middleware for capability denial path (records `forbidden`)

**Tests:** parallel fan-out + fail-open + failure-log-no-payload + strict-mode opt-in

**Why now:** the dispatch layer. Required before write handlers can emit events.

### Cut 4: Pseudonymization + sourceIp / userAgent

**Files added:**
- `packages/gazetta/src/audit/pseudonymize.ts` — `sha256(sub + GAZETTA_AUDIT_ACTOR_SALT)` + 16-char prefix
- `packages/gazetta/src/audit/source-ip.ts` — trust-mode-driven extraction (Cf-Connecting-IP, X-Forwarded-For with `trustedProxyCount`, etc.)
- `packages/gazetta/src/audit/user-agent.ts` — full / truncated / none modes

**Tests:** salt rotation + IP truncation per CIDR + trust-mode dispatch + missing-header → omit field

**Why now:** privacy posture; opt-in but ready for compliance contexts.

### Cut 5: Wire write handlers

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — emit audit on save / delete (success + failure paths)
- Same across `fragments.ts`, `assets.ts`, `publish.ts`, `history.ts` (restore), `site.ts` (configure-roles)

**Tests:** integration tests per route × per outcome class confirming audit events fire correctly

**Why now:** mechanical integration; each route adds one or two `recordToAll()` calls.

### Cut 6: Audit query endpoint + drawer UI

**Files added:**
- `packages/gazetta/src/admin-api/routes/audit.ts` — `GET /api/audit` with `AuditQuery` filters + capability-gated
- `packages/gazetta/src/admin-api/schemas/audit.ts` — Zod schemas for query + response
- `apps/admin/src/client/components/AuditDrawer.vue` — drawer UI with filter chips + per-row outcome badges + click-to-detail
- `apps/admin/src/client/stores/audit.ts` — Pinia store

**Tests:** route happy-path + filter combinations + admin drawer renders + filters compose correctly

**Why now:** the visible feature. Operators can browse the audit log.

### Cut 7: `queryUrl()` deep-link UX

**Files added:**
- `apps/admin/src/client/components/AuditDrawer.vue` — handle 4 drawer states (history-only, history+external, external-only-with-link, external-only-no-link) per design-audit.md Q4 lock

**Why now:** forward-compat for v2 external sinks. Even though v1 ships only `HistoryAuditProvider`, the UI handles all states correctly so v2 plug-in is no UX change.

### Cut 8: Retention pruner

**Files added:**
- `packages/gazetta/src/audit/retention.ts` — extends history pruner with audit-retention pass; handles audit-only revisions (failure outcomes have no content snapshot) + content-bearing-but-audit-stripped revisions
- Background job: scheduled at admin boot + every 6 hours

**Tests:** retention budget + age-based eviction + audit-only vs content-bearing distinction

**Why now:** background work; doesn't block other cuts.

### Cut 9: Capability gating

**Files modified:**
- `packages/gazetta/src/admin-api/routes/audit.ts` — `requireCapability('read:audit-log')` middleware

**Tests:** 403 for non-admin + admin sees full feed

**Why now:** RBAC integration; depends on AuthIdentity (Phase 1 prior).

### Cut 10: Docs

**Files added/modified:**
- `docs/audit.md` (NEW) — operator guide with provider configurations + privacy posture
- `docs/cloudflare.md` + `docs/self-hosted.md` — audit configuration sections
- `examples/starter/site.config.ts` — example `admin.audit` block

**Why last:** code is stable; docs reflect reality.

## Validation gate (definition of done)

- [ ] All 10 cuts merged
- [ ] At least one Phase 2 feature consumes the `Principal` type via the audit middleware (Hooks foundation will compose; that's the validating consumer)
- [ ] Operator can review audit drawer following only public docs
- [ ] Retention pruner has been observed to prune correctly in a manual test scenario

## Deferred items

| Item | Trigger to revisit |
|---|---|
| `HttpWebhookAuditProvider` (v2 expected order #1) | First operator request |
| `FileAuditProvider` (v2 #2) | Self-hosted operator with rsyslog/Fluent Bit demand |
| `OpenTelemetryAuditProvider` (v2 #3) | OTel adoption signal |
| `CloudWatchAuditProvider` / `AzureMonitorAuditProvider` (v2 #4-5) | Cloud-specific operator demand |
| `SyslogAuditProvider` (v2 #6) | Niche; lowest priority |
| Audit reads (`outcome: 'read'` for GET requests) | Compliance-tier demand |
| Hook firing audit | Hooks foundation lands; compose then |
| Index sidecars (`.gazetta/audit-index/`) | Latency p95 > 2s OR event count > 100K OR 3+ operator reports |

## Open implementation questions

1. **`recordToAll` error handling**: when `Promise.allSettled` returns rejected results, log failure + continue. Confirm: structured log entry shape; uses `pino` from `design-logging.md`.
2. **Audit drawer pagination**: at envelope (~25K events/year), full scan is fine; if drawer query needs cursor pagination, lands in Cut 6 OR deferred to first operator pain.
3. **Retention pruner concurrency**: two admin instances pruning concurrently — per-revision file-level idempotency means delete-already-deleted is no-op; race-safe.

## Test infrastructure

- **Real-shape audit fixtures**: capture one full audit event per `action` × outcome combination; use as test data
- **Per-provider contract tests** (`auditProviderContractTests` from `gazetta/testing`): plugin authors validate against the contract; v1 in-tree providers also use the helper

## Estimates

| Cut | Estimate |
|---|---|
| 1 (Infrastructure) | 0.5 day |
| 2 (Provider + HistoryAuditProvider) | 1 day |
| 3 (Recorder + middleware) | 1 day |
| 4 (Pseudonymization + sourceIp) | 1.5 days |
| 5 (Wire write handlers) | 1.5 days |
| 6 (Query endpoint + drawer) | 2 days |
| 7 (queryUrl drawer states) | 0.5 day |
| 8 (Retention pruner) | 1 day |
| 9 (Capability gate) | 0.5 day |
| 10 (Docs) | 1 day |

**Total: ~10-11 days.** With CI + integration discoveries, budget ~2 weeks.

## SOLID checks per cut

- **Cut 1-2**: SRP per file. LSP across providers (`HistoryAuditProvider` is the v1 reference). DIP — consumers depend on `AuditProvider` interface.
- **Cut 3**: SRP — recorder owns dispatch + failure-log; middleware owns capability-denial-recording.
- **Cut 4**: SRP — each privacy concern in its own module (pseudonymize / sourceIp / userAgent).
- **Cut 6**: ISP — drawer UI consumes only the query API surface; doesn't touch recorder internals.
- **Cut 8**: SRP — retention pruner is its own module; doesn't bleed into recorder.
