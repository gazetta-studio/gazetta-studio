/**
 * API composables — narrow, per-concern slices over the api client.
 *
 * Components consume exactly the api methods they need (ISP). Tests
 * inject fakes via `app.provide(KEY, fake)` without touching module
 * imports. Production wiring is automatic: every composable defaults
 * to the real `api` object, so no `app.provide()` call is required
 * unless you want to override.
 *
 * Extends the active-target provider pattern already present in the
 * api client (setActiveTargetProvider) — generalized to consumer-side
 * dependency injection via Vue's provide/inject.
 *
 * Six slices:
 *   - PagesApi        pages CRUD
 *   - FragmentsApi    fragments CRUD + dependents
 *   - TemplatesApi    templates + fields (schema-adjacent)
 *   - TargetsApi      targets + site manifest
 *   - PublishApi      publish / compare / fetch
 *   - HistoryApi      revisions + undo/restore
 */
import { inject, type InjectionKey } from 'vue'
import {
  api,
  type PageSummary,
  type PageDetail,
  type FragmentSummary,
  type FragmentDetail,
  type TemplateSummary,
  type FieldSummary,
  type TargetInfo,
  type SiteManifest,
  type PublishResult,
  type PublishProgress,
  type CompareResult,
  type RevisionSummary,
  type DependentsResponse,
  type AuditQueryFilter,
  type AuditQueryResponse,
  type ValidationIssue,
} from '../api/client.js'

// ---- Pages -----------------------------------------------------------------

export interface PagesApi {
  getPages(opts?: { target?: string }): Promise<PageSummary[]>
  getPage(name: string, options?: RequestInit): Promise<PageDetail>
  createPage(data: { name: string; template: string }): Promise<{ ok: boolean; name: string }>
  deletePage(name: string): Promise<{ ok: boolean }>
  updatePage(name: string, data: Partial<PageDetail>): Promise<{ ok: boolean }>
}
export const PAGES_API: InjectionKey<PagesApi> = Symbol('PagesApi')
export function usePagesApi(): PagesApi {
  return inject(PAGES_API, api)
}

// ---- Fragments (+ dependents) ---------------------------------------------

export interface FragmentsApi {
  getFragments(opts?: { target?: string }): Promise<FragmentSummary[]>
  getFragment(name: string, options?: RequestInit): Promise<FragmentDetail>
  createFragment(data: { name: string; template: string }): Promise<{ ok: boolean; name: string }>
  deleteFragment(name: string): Promise<{ ok: boolean }>
  updateFragment(name: string, data: Partial<FragmentDetail>): Promise<{ ok: boolean }>
  getDependents(item: string, options?: RequestInit): Promise<DependentsResponse>
}
export const FRAGMENTS_API: InjectionKey<FragmentsApi> = Symbol('FragmentsApi')
export function useFragmentsApi(): FragmentsApi {
  return inject(FRAGMENTS_API, api)
}

// ---- Templates (+ fields) -------------------------------------------------

export interface TemplatesApi {
  getTemplates(): Promise<TemplateSummary[]>
  getTemplateSchema(name: string): Promise<Record<string, unknown>>
  getFields(): Promise<FieldSummary[]>
}
export const TEMPLATES_API: InjectionKey<TemplatesApi> = Symbol('TemplatesApi')
export function useTemplatesApi(): TemplatesApi {
  return inject(TEMPLATES_API, api)
}

// ---- Targets (+ site) -----------------------------------------------------

export interface TargetsApi {
  getTargets(): Promise<TargetInfo[]>
  getSite(): Promise<SiteManifest>
}
export const TARGETS_API: InjectionKey<TargetsApi> = Symbol('TargetsApi')
export function useTargetsApi(): TargetsApi {
  return inject(TARGETS_API, api)
}

// ---- Publish --------------------------------------------------------------

export interface PublishApi {
  publish(items: string[], targets: string[]): Promise<{ results: PublishResult[] }>
  publishStream(
    items: string[],
    targets: string[],
    onProgress: (ev: PublishProgress) => void,
    options?: { source?: string; signal?: AbortSignal },
  ): Promise<PublishResult[]>
  publishAudit(
    target: string,
    items: ReadonlyArray<{ kind: 'page' | 'fragment'; name: string }>,
  ): Promise<{ issues: ValidationIssue[]; strict: boolean }>
  compare(target: string, options?: RequestInit & { source?: string }): Promise<CompareResult>
  fetchFromTarget(source: string, items?: string[]): Promise<{ success: boolean; copiedFiles: number; items: string[] }>
}
export const PUBLISH_API: InjectionKey<PublishApi> = Symbol('PublishApi')
export function usePublishApi(): PublishApi {
  return inject(PUBLISH_API, api)
}

// ---- History --------------------------------------------------------------

export interface HistoryApi {
  listHistory(target: string, limit?: number): Promise<{ revisions: RevisionSummary[] }>
  undoLastWrite(target: string): Promise<{ revision: RevisionSummary; restoredFrom: string }>
  restoreRevision(target: string, revisionId: string): Promise<{ revision: RevisionSummary; restoredFrom: string }>
}
export const HISTORY_API: InjectionKey<HistoryApi> = Symbol('HistoryApi')
export function useHistoryApi(): HistoryApi {
  return inject(HISTORY_API, api)
}

// ---- Audit ----------------------------------------------------------------

export interface AuditApi {
  queryAudit(filter?: AuditQueryFilter): Promise<AuditQueryResponse>
}
export const AUDIT_API: InjectionKey<AuditApi> = Symbol('AuditApi')
export function useAuditApi(): AuditApi {
  return inject(AUDIT_API, api)
}
