/**
 * Actor pseudonymization — opt-in privacy hardening for audit events.
 *
 * Per `design-audit.md`'s "Pseudonymization" section: when
 * `admin.audit.actorPseudonym: 'sha256'` is configured, the event's
 * `actor.id` is replaced with `sha256(sub + GAZETTA_AUDIT_ACTOR_SALT)
 * .slice(0, 16)`. The `actor.email` field is dropped (low-entropy
 * email gives weak pseudonymization).
 *
 * # When to opt in
 *
 * - External-sink configurations where audit events leave Gazetta's
 *   process boundary (CloudWatch, OTel, webhook) — limits PII
 *   leakage if sink storage is compromised
 * - Regulated contexts demanding pseudonymization-by-default (some
 *   EU healthcare contexts, German telecommunications data
 *   retention)
 * - Multi-tenant SIEM correlation with shared salt across systems
 *
 * # Salt management
 *
 * - Salt is a credential. Stored in `GAZETTA_AUDIT_ACTOR_SALT` env
 *   var per Universal Provider Requirement #3. Never in
 *   `site.config.ts`.
 * - 16+ random bytes recommended.
 * - Salt rotation breaks historic correlation by design — rotate
 *   per security policy (annually typical); document rotation
 *   dates so forensic queries can scope by salt-era.
 * - Multi-instance: every instance reads the same env → deterministic
 *   hash across instances.
 *
 * # SOLID lenses
 *
 *   - SRP: pseudonymization only. Doesn't dispatch, doesn't extract
 *     identity. Pure function over `(actor, mode)`.
 *   - DIP: takes the salt as a string parameter (dependency-injected
 *     by the caller); doesn't read `process.env` directly so tests
 *     can pass deterministic salts.
 */
import { createHash } from 'node:crypto'
import type { AuditActor } from './types.js'

export type ActorPseudonymMode = 'none' | 'sha256'

/**
 * Apply the configured pseudonymization mode to an actor snapshot.
 *
 *   - `'none'` (default) — pass through unchanged.
 *   - `'sha256'` — replace `id` with the salted hash prefix; drop
 *     `email`.
 *
 * The original `actor` is never mutated; returns a new object.
 *
 * Throws when `mode === 'sha256'` and `salt` is empty/undefined —
 * pseudonymization without a salt is a misconfiguration that would
 * silently produce reversible-by-rainbow-table hashes. Caller (Cut
 * 5's wiring) should catch this at boot via `AuditConfigurationError`
 * when the env var is missing.
 */
export function pseudonymizeActor(actor: AuditActor, mode: ActorPseudonymMode, salt?: string): AuditActor {
  if (mode === 'none') return actor
  // mode === 'sha256'
  if (!salt || salt.length === 0) {
    throw new Error(
      'actorPseudonym: sha256 requires a non-empty salt (set GAZETTA_AUDIT_ACTOR_SALT environment variable)',
    )
  }
  const hash = createHash('sha256')
    .update(actor.id + salt)
    .digest('hex')
    .slice(0, 16)
  return {
    id: hash,
    // email dropped — low-entropy email gives weak pseudonymization.
    role: actor.role,
    trustMode: actor.trustMode,
  }
}

/**
 * Compute the pseudonymized id for an actor — exposed for forensic
 * queries: an operator who knows the upstream sub + salt can
 * compute the pseudonymized id and search the audit log without
 * the recorder being involved.
 */
export function computePseudonymizedId(rawSub: string, salt: string): string {
  return createHash('sha256')
    .update(rawSub + salt)
    .digest('hex')
    .slice(0, 16)
}
