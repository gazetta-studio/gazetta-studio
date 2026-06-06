/**
 * Asset upload — queue pending uploads, expose per-file progress, route
 * errors to per-file state.
 *
 * Single responsibility: uploads in flight. No listing (the list store
 * refreshes after each successful upload), no selection, no modal state.
 *
 * Model:
 * - Each queued upload gets an id + File + desiredName + alt + status
 * - Status transitions: `queued` → `uploading` → `success` | `error`
 * - Concurrency: one upload at a time for v1 (simplest; no ordering surprises).
 *   Wide rollout may parallelize.
 *
 * The store emits nothing — UI reads from `uploads` directly. After a
 * successful upload the caller is expected to refresh the list store;
 * the upload store doesn't couple itself to list.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  type AssetSelector,
  type UploadedAsset,
  uploadAsset as uploadAssetApi,
  uploadLocaleBytes as uploadLocaleBytesApi,
} from '../api/assets.js'

export type UploadAsset = (file: File, name: string, alt: string | null) => Promise<UploadedAsset>
export type UploadLocaleBytes = (name: string, selector: AssetSelector, file: File) => Promise<UploadedAsset>

export interface AssetsUploadStoreOptions {
  uploadAsset?: UploadAsset
  uploadLocaleBytes?: UploadLocaleBytes
}

type UploadStatus = 'queued' | 'uploading' | 'success' | 'error'

/** What kind of upload this entry represents. */
type UploadKind = 'default' | 'locale-bytes'

export interface UploadEntry {
  id: string
  file: File
  name: string
  alt: string | null
  status: UploadStatus
  kind: UploadKind
  /** Selector for locale-bytes uploads; undefined for default uploads. */
  selector: AssetSelector | null
  /** Typed error code from the server (ASSET_VALIDATION_FAILED, etc.) or null. */
  errorCode: string | null
  /** Human-readable error message, when status === 'error'. */
  errorMessage: string | null
  /** Server-returned path to the persisted bytes, when status === 'success'. */
  bytesPath: string | null
}

export const useAssetsUploadStore = defineStore('assetsUpload', () => {
  const uploads = ref<UploadEntry[]>([])

  let uploadAsset: UploadAsset = (file, name, alt) => uploadAssetApi(file, name, alt)
  let uploadLocaleBytes: UploadLocaleBytes = (name, selector, file) => uploadLocaleBytesApi(name, selector, file)

  function configure(options: AssetsUploadStoreOptions): void {
    if (options.uploadAsset) uploadAsset = options.uploadAsset
    if (options.uploadLocaleBytes) uploadLocaleBytes = options.uploadLocaleBytes
  }

  const hasActive = computed(() => uploads.value.some(u => u.status === 'queued' || u.status === 'uploading'))
  const hasErrors = computed(() => uploads.value.some(u => u.status === 'error'))

  /**
   * Enqueue a default-asset file. Equivalent to "upload bytes for the
   * default locale of an asset that doesn't exist yet" or "replace the
   * default bytes of an existing asset."
   */
  function enqueue(file: File, name: string, alt: string | null): string {
    return push({
      file,
      name,
      alt,
      kind: 'default',
      selector: null,
    })
  }

  /**
   * Enqueue a locale-bytes override upload. The default asset must
   * already exist on the target — server-side throws 404 if not.
   * Selector picks which (locale, theme) variant we're writing.
   */
  function enqueueLocaleBytes(file: File, name: string, selector: AssetSelector): string {
    return push({
      file,
      name,
      alt: null,
      kind: 'locale-bytes',
      selector,
    })
  }

  function push(entry: Omit<UploadEntry, 'id' | 'status' | 'errorCode' | 'errorMessage' | 'bytesPath'>): string {
    const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    uploads.value.push({
      id,
      ...entry,
      status: 'queued',
      errorCode: null,
      errorMessage: null,
      bytesPath: null,
    })
    void drainQueue()
    return id
  }

  /** Clear completed (success) entries from the list. */
  function clearSuccesses(): void {
    uploads.value = uploads.value.filter(u => u.status !== 'success')
  }

  /** Clear error entries from the list. */
  function clearErrors(): void {
    uploads.value = uploads.value.filter(u => u.status !== 'error')
  }

  /** Drain the queue — run one upload at a time. */
  async function drainQueue(): Promise<void> {
    const alreadyActive = uploads.value.some(u => u.status === 'uploading')
    if (alreadyActive) return

    const next = uploads.value.find(u => u.status === 'queued')
    if (!next) return

    next.status = 'uploading'
    try {
      const result =
        next.kind === 'locale-bytes' && next.selector !== null
          ? await uploadLocaleBytes(next.name, next.selector, next.file)
          : await uploadAsset(next.file, next.name, next.alt)
      next.status = 'success'
      next.bytesPath = result.bytesPath
    } catch (err) {
      next.status = 'error'
      next.errorMessage = (err as Error).message
      next.errorCode = (err as Error & { code?: string }).code ?? null
    }

    // Tail-call into the next queued entry without recursion growing the stack
    void drainQueue()
  }

  return {
    uploads,
    hasActive,
    hasErrors,
    enqueue,
    enqueueLocaleBytes,
    clearSuccesses,
    clearErrors,
    configure,
  }
})
