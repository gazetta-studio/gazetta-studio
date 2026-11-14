/**
 * Where a target's audit events are recorded (design-public-storage.md
 * Q5): the target itself if its storage is private, else the first
 * target in `site.config.ts` order whose storage is private, else
 * nowhere. An external audit sink would come third; none ships yet
 * (`AuditConfigSchema` accepts only `provider: 'history'`).
 */
import { isPublicStorage, type PublicStorageFields } from './types.js'

export type AuditHome = { kind: 'self' } | { kind: 'target'; name: string } | { kind: 'none' }

export function auditHomeFor(targetName: string, configs: Readonly<Record<string, PublicStorageFields>>): AuditHome {
  const own = configs[targetName]
  if (own && !isPublicStorage(own)) return { kind: 'self' }
  for (const [name, config] of Object.entries(configs)) {
    if (!isPublicStorage(config)) return { kind: 'target', name }
  }
  return { kind: 'none' }
}
