/**
 * Audit barrel export. Cuts 2-9 add to this surface (`AuditProvider`
 * interface, `HistoryAuditProvider`, recorder, query route).
 */
export type { AuditAction, AuditActor, AuditEvent, AuditOutcome, AuditQuery, AuditScope } from './types.js'
export { AuditError, AuditConfigurationError, AuditTransportError } from './errors.js'
export { AuditConfigSchema, DEFAULT_AUDIT_CONFIG, type AuditConfig } from './config.js'
export type { AuditProvider } from './provider.js'
export { createHistoryAuditProvider, type HistoryAuditProviderOptions } from './providers/history.js'
export {
  recordToAll,
  type AuditFailureLog,
  type AuditFailureLogger,
  type RecordResult,
  type RecordToAllOptions,
} from './recorder.js'
export { computePseudonymizedId, pseudonymizeActor, type ActorPseudonymMode } from './pseudonymize.js'
export {
  extractSourceIp,
  processSourceIp,
  type SourceIpExtractionContext,
  type SourceIpMode,
} from './source-ip.js'
export { processUserAgent, type UserAgentMode } from './user-agent.js'
export { pruneAuditEvents, type AuditRetentionConfig, type PruneResult } from './retention.js'
export {
  createAuditContext,
  type AuditContext,
  type AuditContextOptions,
  type RecordEventInput,
} from './context.js'
