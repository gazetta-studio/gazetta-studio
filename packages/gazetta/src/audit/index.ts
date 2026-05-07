/**
 * Audit barrel export. Cuts 2-9 add to this surface (`AuditProvider`
 * interface, `HistoryAuditProvider`, recorder, query route).
 */
export type { AuditAction, AuditActor, AuditEvent, AuditOutcome, AuditQuery, AuditScope } from './types.js'
export { AuditError, AuditConfigurationError, AuditTransportError } from './errors.js'
export { AuditConfigSchema, DEFAULT_AUDIT_CONFIG, type AuditConfig } from './config.js'
