// API is relative to the CMS base path: /admin/api, /cms/api, or /api
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') + '/api'

/**
 * Active-target provider — injected at app boot. When set, content-reading
 * api calls auto-append `?target=<active>` so the server reads from the
 * target the author is focused on.
 *
 * Kept as an injected function rather than an import to preserve DIP: the
 * api client doesn't depend on the active-target store (the store wires
 * itself in via main.ts).
 */
type ActiveTargetProvider = () => string | null
let activeTargetProvider: ActiveTargetProvider | null = null

/** Wire the api client to read the active target from the provided source. */
export function setActiveTargetProvider(provider: ActiveTargetProvider | null): void {
  activeTargetProvider = provider
}

/**
 * Append `?target=<active>` to a URL path when the active-target provider
 * is set and the path doesn't already specify a target. Query string is
 * added before any existing `#fragment` (none expected in api URLs).
 */
function withActiveTarget(path: string): string {
  const name = activeTargetProvider?.()
  if (!name) return path
  // Skip if caller already set ?target= explicitly (e.g., compare destination)
  if (/[?&]target=/.test(path)) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}target=${encodeURIComponent(name)}`
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem('gazetta_token')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${withActiveTarget(path)}`, {
    ...options,
    headers: { ...headers, ...options?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  return res.json()
}

/**
 * Upload helper — sends multipart FormData. Distinct from `request()`
 * because multipart mustn't carry Content-Type: application/json, and
 * because the server's error shape for the upload route is `{ code,
 * message }` (typed AssetError) rather than `{ error }`.
 */
async function uploadRequest<T>(path: string, form: FormData): Promise<T> {
  const token = sessionStorage.getItem('gazetta_token')
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${withActiveTarget(path)}`, {
    method: 'POST',
    headers,
    body: form,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ message: res.statusText }))) as {
      code?: string
      message?: string
    }
    const err = new Error(body.message ?? `Upload failed: ${res.status}`) as Error & {
      code?: string
      status: number
    }
    err.code = body.code
    err.status = res.status
    throw err
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
  const token = sessionStorage.getItem('gazetta_token')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const body: Record<string, unknown> = { items, targets }
  if (options?.source) body.source = options.source
  const res = await fetch(`${BASE}/publish/stream`, {
    method: 'POST',
    headers,
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
 * Asset summary returned by GET /api/assets.
 * Re-exported from `gazetta/schema` — single source of truth for the shape
 * lives in the gazetta package (schema/types.ts). If the server changes
 * the shape, the admin is a compile error rather than runtime drift.
 */
export type { AssetSummary } from 'gazetta/schema'
import type { AssetSummary } from 'gazetta/schema'

/** Manifest returned by a successful upload. */
export interface UploadedAsset {
  manifest: AssetSummary & { version: 1; source: 'internal'; uploadedBy: string }
  bytesPath: string
}

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
    const src = options?.source ?? activeTargetProvider?.()
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
  /**
   * Upload an asset. On success returns the new asset's manifest + bytes path.
   * On failure throws an Error with `code` (typed AssetError code) and
   * `status` (HTTP status) attached so the caller can route to the right UI.
   */
  uploadAsset: (file: File, name: string, alt: string | null) => {
    const form = new FormData()
    form.set('file', file)
    form.set('name', name)
    if (alt !== null) form.set('alt', alt)
    return uploadRequest<UploadedAsset>('/assets', form)
  },
  /**
   * Delete an asset. Resolves on 204 (no content). On 409 throws an
   * `AssetInUseError` carrying the usage list so the caller can render
   * the "replace or cancel" dialog. On 404 or 500 throws a generic Error
   * with the server's error code.
   */
  deleteAsset: async (name: string): Promise<void> => {
    await deleteAssetRequest(name)
  },
}

/** Matches the AssetRef shape returned by the server on 409 responses. */
export interface AssetRefShape {
  source: 'page' | 'fragment'
  path: string
  componentPath: string
}

/** Thrown client-side when the server returns 409 on asset delete. */
export class AssetInUseError extends Error {
  readonly code = 'ASSET_IN_USE' as const
  constructor(
    public readonly assetName: string,
    public readonly refs: readonly AssetRefShape[],
  ) {
    super(`Asset "${assetName}" is still referenced by ${refs.length} item(s)`)
    this.name = 'AssetInUseError'
  }
}

async function deleteAssetRequest(name: string): Promise<void> {
  const token = sessionStorage.getItem('gazetta_token')
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${withActiveTarget(`/assets/${encodeURIComponent(name)}`)}`, {
    method: 'DELETE',
    headers,
  })
  if (res.status === 204) return
  // 409 — refs still exist. Body is { code, message, assetName, refs }.
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      assetName?: string
      refs?: AssetRefShape[]
    }
    throw new AssetInUseError(body.assetName ?? name, body.refs ?? [])
  }
  const body = (await res.json().catch(() => ({ message: res.statusText }))) as {
    code?: string
    message?: string
  }
  const err = new Error(body.message ?? `Delete failed: ${res.status}`) as Error & {
    code?: string
    status: number
  }
  err.code = body.code
  err.status = res.status
  throw err
}
