---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "packages/gazetta/src/history-recorder.ts"
  - "packages/gazetta/src/history.ts"
  - "**/auth*"
  - "**/role*"
---

# RBAC + audit log + review workflows — design pass pending

Foundational dimension #4 of 8. Joint design across role-based access control, audit logging, and review workflow state. The team-CMS feature set.

**Status**: design pass pending — sequenced 5 of 8 (after `design-themes.md`). See [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Team check** every new feature design must answer
- [`design-publishing.md`](design-publishing.md) — history-recorder is the existing primitive; audit log extends it with actor identity
- [`design-editor-ux.md`](design-editor-ux.md) — Active target + Save semantics that review workflow gates on

## Why this is foundational

Strategic commitment locked: **Gazetta is a team CMS**, not a solo developer tool. Every API endpoint, every admin action, every save/publish operation gates on roles. Every write records (who, what, when, where). Save/publish flows respect review state.

Adding any of these later means auditing every consumer. Joint design — not three separate designs — because the three concerns interact: review workflows reference audit events; audit events reference roles; roles gate review actions.

## Locked invariants (already decided)

- **history-recorder is the foundation for audit log.** `recordWrite()` already runs on every save and publish ([packages/gazetta/src/history-recorder.ts](../../packages/gazetta/src/history-recorder.ts)). The audit log adds an `actor` field; doesn't replace the existing primitive.
- **Audit log is the source of real-time events.** Per the real-time event-source discipline in `feature-design-process.md`, save/publish handlers record to audit log; real-time push (presence, live publish status) observes audit log. Not bolted into save/publish handlers directly.
- **Permission-filtered output composes here, not in a separate search design.** Filtered listings, search results, dependents queries — all filter by role via the same gate.
- **Per-target review state.** Review workflows are scoped to the destination target (a publish to `staging` is reviewed independently from a publish to `production`), not site-wide.

## Open questions for the design pass

### Roles
- Built-in role names — `admin` / `editor` / `viewer` / custom? Or fully configurable?
- Per-target roles vs. site-wide roles? (E.g., editor on staging but viewer on prod)
- Per-page roles? (E.g., "you can edit /docs/* but not /blog/*") — out of scope for v1?

### Authorization gates
- Where does the gate live? Hono middleware per-route? Decorator on each handler?
- Failure mode — 403 with structured reason, or 404 (don't leak existence)?
- Discovery — should `/api/pages` filter by what the user can see, or return everything and gate edit per-page?

### Audit log shape
- Fields — `actor` (identity), `action` (type), `target`, `before`/`after` snapshots?
- Storage — append-only? Pruneable? Same `.gazetta/history/` location or separate `.gazetta/audit/`?
- Retention — separate from history retention? Compliance-grade (longer)?
- Events — every write? Or every API call (including reads)?
- Actor identity — username string? UUID? Provider-specific (OIDC sub, basic-auth user)?

### Review workflow state machine
- States — `draft` → `review` → `approved` → `published`? Or simpler (`draft` / `published`)?
- Transitions — who can move state? Per-role?
- Per-target — does staging require review? Production always? Configurable per `site.yaml`?
- Composition with active target — review state visible in active target switcher?

### Auth provider
- Built-in (Basic Auth, magic link, password) or provider-agnostic (OIDC, OAuth, SAML)?
- Self-hosted operators vs. cloud — same auth model or split?

### Real-time events
- Presence (who's connected, what they're focused on) — when does this design pass land vs. when does presence implement?
- Audit log → real-time channel — separate observer; verify the contract here.

### Composition with hooks
- Hooks fire with actor context — RBAC must be settled before hooks design
- Audit log records hook firings? Or hooks are infra, not audited?

## Migration

Sites without RBAC config continue to work in single-author mode (current). Adding `auth:` config enables the team-CMS layer. Existing history records get a synthetic `actor: "unknown"` for pre-RBAC entries.

## Future directions

- Concurrent editing (OT/CRDT) — Tier 3 strategic bet, lands after presence-only ships
- Compliance certifications (SOC 2, HIPAA) — depends on audit log shape; possibly Tier 3
- Custom workflows — beyond `draft → review → approved → published` — operator-defined state machines
- Per-component permissions (within a page) — out of scope for v1
