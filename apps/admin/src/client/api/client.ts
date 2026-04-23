// Wire-level plumbing (base URL, active-target injection, auth headers)
// lives in `_request.ts` and is shared with other API modules (e.g.
// `api/assets.ts`). Everything in this file is JSON-CRUD specific.
import { API_BASE as BASE, apiUrl, authHeaders, getActiveTarget } from './_request.js'

export { setActiveTargetProvider } from './_request.js'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options?.headers as Record<string, string>) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  return res.json()
}

/**
 * POST to /publish/stream and parse SSE events as they arrive. Calls
 * onProgress for every event including the final 'done'. Returns the
 * 'done' event's results once the stream closes. Throws on 'fatal'.
 *
 * EventSource isn't usable here (it only supports GET), so we read the
 * response body as a stream and parse SSE manually.
 */
async function publishStream(
  items: string[],
  targets: string[],
  onProgress: (ev: PublishProgress) => void,
  options?: { source?: string; signal?: AbortSignal },
): Promise<PublishResult[]> {
  const body: Record<string, unknown> = { items, targets }
  if (options?.source) body.source = options.source
  const res = await fetch(`${BASE}/publish/stream`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Stream failed: ${res.status}`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let results: PublishResult[] = []
  let fatalError: { error: string; invalidTemplates?: { name: string; errors: string[] }[] } | null = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    // SSE events are separated by blank lines (\n\n)
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      const ev = JSON.parse(dataLines.join('\n')) as PublishProgress
      onProgress(ev)
      if (ev.kind === 'done') results = ev.results
      else if (ev.kind === 'fatal') fatalError = { error: ev.error, invalidTemplates: ev.invalidTemplates }
    }
  }

  if (fatalError) {
    const err = new Error(fatalError.error) as Error & { invalidTemplates?: { name: string; errors: string[] }[] }
    if (fatalError.invalidTemplates) err.invalidTemplates = fatalError.invalidTemplates
    throw err
  }
  return results
}

// Summary + create request/response types come from the shared schema
// source-of-truth in gazetta/admin-api/schemas. Any drift between these
// and the server's Zod schema is a compile error at build time —
// enforced here rather than at runtime.
import type {
  PageSummary as PageSummaryShape,
  CreatePageRequest as CreatePageRequestShape,
  CreatePageResponse as CreatePageResponseShape,
  PageMetadata as PageMetadataShape,
  FragmentSummary as FragmentSummaryShape,
  CreateFragmentRequest as CreateFragmentRequestShape,
  CreateFragmentResponse as CreateFragmentResponseShape,
  TemplateSummary as TemplateSummaryShape,
  FieldSummary as FieldSummaryShape,
  TargetInfo as TargetInfoShape,
  TargetEnvironment as TargetEnvironmentShape,
  TargetType as TargetTypeShape,
  SiteManifest as SiteManifestShape,
  DependentsResponse as DependentsResponseShape,
  CompareResult as CompareResultShape,
  PublishResult as PublishResultShape,
  PublishProgress as PublishProgressShape,
  RevisionSummary as RevisionSummaryShape,
  RevisionOperation as RevisionOperationShape,
  ListHistoryResponse as ListHistoryResponseShape,
  RestoreRevisionResponse as RestoreRevisionResponseShape,
  FetchResponse as FetchResponseShape,
} from 'gazetta/admin-api/schemas'
export type PageSummary = PageSummaryShape
export type CreatePageRequest = CreatePageRequestShape
export type CreatePageResponse = CreatePageResponseShape
export type PageMetadata = PageMetadataShape
export type FragmentSummary = FragmentSummaryShape
export type CreateFragmentRequest = CreateFragmentRequestShape
export type CreateFragmentResponse = CreateFragmentResponseShape
export type TemplateSummary = TemplateSummaryShape
export type FieldSummary = FieldSummaryShape
export type TargetInfo = TargetInfoShape
export type TargetEnvironment = TargetEnvironmentShape
export type TargetType = TargetTypeShape
export type SiteManifest = SiteManifestShape
export type DependentsResponse = DependentsResponseShape
export type CompareResult = CompareResultShape
export type PublishResult = PublishResultShape
export type PublishProgress = PublishProgressShape
export type RevisionSummary = RevisionSummaryShape
export type RevisionOperation = RevisionOperationShape
export type ListHistoryResponse = ListHistoryResponseShape
export type RestoreRevisionResponse = RestoreRevisionResponseShape
export type FetchResponse = FetchResponseShape

export interface InlineComponent {
  name: string
  template: string
  content?: Record<string, unknown>
  components?: ComponentEntry[]
}
export type ComponentEntry = string | InlineComponent

export interface PageDetail extends PageSummary {
  content?: Record<string, unknown>
  components?: ComponentEntry[]
  metadata?: PageMetadata
  dir: string
  /** Current locale (when loaded via ?locale=) */
  locale?: string
  /** Available locale codes for this page */
  locales?: string[]
}

export interface FragmentDetail extends FragmentSummary {
  content?: Record<string, unknown>
  components?: ComponentEntry[]
  dir: string
  locale?: string
  locales?: string[]
}

/**
 * `AssetSummary` is used by `listAssets` / `getAsset` below; the asset-
 * specific endpoints (`uploadAsset`, `deleteAsset`) and their typed
 * errors (`AssetInUseError`, `AssetApiError`) live in `./assets.ts` —
 * callers import those directly from `./assets.js`.
 */
import type { AssetSummary } from 'gazetta/schema'

export const api = {
  getSite: () => request<SiteManifest>('/site'),
  /** List pages. Without `target`, uses the active target (auto-appended).
   *  Pass `target` to list from a specific target — used when pre-checking
   *  item availability before switching the active target. */
  getPages: (opts?: { target?: string }) =>
    request<PageSummary[]>(opts?.target ? `/pages?target=${encodeURIComponent(opts.target)}` : '/pages'),
  getPage: (name: string, options?: RequestInit & { locale?: string }) => {
    const path = options?.locale ? `/pages/${name}?locale=${encodeURIComponent(options.locale)}` : `/pages/${name}`
    return request<PageDetail>(path, options)
  },
  createPage: (data: CreatePageRequest) =>
    request<CreatePageResponse>('/pages', { method: 'POST', body: JSON.stringify(data) }),
  deletePage: (name: string) => request<{ ok: boolean }>(`/pages/${name}`, { method: 'DELETE' }),
  updatePage: (name: string, data: Partial<PageDetail>, opts?: { locale?: string }) => {
    const qs = opts?.locale ? `?locale=${encodeURIComponent(opts.locale)}` : ''
    return request<{ ok: boolean }>(`/pages/${name}${qs}`, { method: 'PUT', body: JSON.stringify(data) })
  },
  /** List fragments. See getPages for the `target` option. */
  getFragments: (opts?: { target?: string }) =>
    request<FragmentSummary[]>(opts?.target ? `/fragments?target=${encodeURIComponent(opts.target)}` : '/fragments'),
  getFragment: (name: string, options?: RequestInit & { locale?: string }) => {
    const path = options?.locale
      ? `/fragments/${name}?locale=${encodeURIComponent(options.locale)}`
      : `/fragments/${name}`
    return request<FragmentDetail>(path, options)
  },
  createFragment: (data: CreateFragmentRequest) =>
    request<CreateFragmentResponse>('/fragments', { method: 'POST', body: JSON.stringify(data) }),
  deleteFragment: (name: string) => request<{ ok: boolean }>(`/fragments/${name}`, { method: 'DELETE' }),
  updateFragment: (name: string, data: Partial<FragmentDetail>, opts?: { locale?: string }) => {
    const qs = opts?.locale ? `?locale=${encodeURIComponent(opts.locale)}` : ''
    return request<{ ok: boolean }>(`/fragments/${name}${qs}`, { method: 'PUT', body: JSON.stringify(data) })
  },
  getTemplates: () => request<TemplateSummary[]>('/templates'),
  getTemplateSchema: (name: string, options?: RequestInit) =>
    request<Record<string, unknown>>(`/templates/${name}/schema`, options),
  getFields: () => request<FieldSummary[]>('/fields'),
  getTargets: () => request<TargetInfo[]>('/targets'),
  publish: (items: string[], targets: string[]) =>
    request<{ results: PublishResult[] }>('/publish', { method: 'POST', body: JSON.stringify({ items, targets }) }),
  publishStream,
  compare: (target: string, options?: RequestInit & { source?: string }) => {
    // `source` explicit wins. Otherwise fall back to the active-target
    // provider (server resolves its own default if neither is set).
    const src = options?.source ?? getActiveTarget()
    const qs = src
      ? `?target=${encodeURIComponent(target)}&source=${encodeURIComponent(src)}`
      : `?target=${encodeURIComponent(target)}`
    return request<CompareResult>(`/compare${qs}`, options)
  },
  getDependents: (item: string, options?: RequestInit) =>
    request<DependentsResponse>(`/dependents?item=${encodeURIComponent(item)}`, options),
  fetchFromTarget: (source: string, items?: string[]) =>
    request<FetchResponse>('/fetch', {
      method: 'POST',
      body: JSON.stringify({ source, items }),
    }),
  /** List revisions on a target, newest first. */
  listHistory: (target: string, limit = 50) =>
    request<ListHistoryResponse>(`/history?target=${encodeURIComponent(target)}&limit=${limit}`),
  /** Undo the most recent write on a target — restores the previous
   *  revision as a forward 'rollback'. 409 when there's nothing to undo. */
  undoLastWrite: (target: string) =>
    request<RestoreRevisionResponse>(`/history/undo?target=${encodeURIComponent(target)}`, {
      method: 'POST',
    }),
  /** Restore an arbitrary revision on a target. 404 when the id doesn't exist. */
  restoreRevision: (target: string, revisionId: string) =>
    request<RestoreRevisionResponse>(
      `/history/restore?target=${encodeURIComponent(target)}&id=${encodeURIComponent(revisionId)}`,
      { method: 'POST' },
    ),
  /** List assets on the active target. Empty array when the target has none. */
  listAssets: () => request<AssetSummary[]>('/assets'),
  /** Fetch a single asset's summary by name. 404s when the asset doesn't exist. */
  getAsset: (name: string) => request<AssetSummary>(`/assets/${encodeURIComponent(name)}`),
}
