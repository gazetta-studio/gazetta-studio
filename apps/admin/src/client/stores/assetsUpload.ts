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
import { api, type UploadedAsset } from '../api/client.js'

export type UploadAsset = (file: File, name: string, alt: string | null) => Promise<UploadedAsset>

export interface AssetsUploadStoreOptions {
  uploadAsset?: UploadAsset
}

export type UploadStatus = 'queued' | 'uploading' | 'success' | 'error'

export interface UploadEntry {
  id: string
  file: File
  name: string
  alt: string | null
  status: UploadStatus
  /** Typed error code from the server (ASSET_VALIDATION_FAILED, etc.) or null. */
  errorCode: string | null
  /** Human-readable error message, when status === 'error'. */
  errorMessage: string | null
  /** Server-returned path to the persisted bytes, when status === 'success'. */
  bytesPath: string | null
}

export const useAssetsUploadStore = defineStore('assetsUpload', () => {
  const uploads = ref<UploadEntry[]>([])

  let uploadAsset: UploadAsset = (file, name, alt) => api.uploadAsset(file, name, alt)

  function configure(options: AssetsUploadStoreOptions): void {
    if (options.uploadAsset) uploadAsset = options.uploadAsset
  }

  const hasActive = computed(() => uploads.value.some(u => u.status === 'queued' || u.status === 'uploading'))
  const hasErrors = computed(() => uploads.value.some(u => u.status === 'error'))

  /**
   * Enqueue a file for upload and start (if nothing else is active).
   * Returns the id assigned to the entry — useful for tests and for
   * tracking a specific upload.
   */
  function enqueue(file: File, name: string, alt: string | null): string {
    const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    uploads.value.push({
      id,
      file,
      name,
      alt,
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
      const result = await uploadAsset(next.file, next.name, next.alt)
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
    clearSuccesses,
    clearErrors,
    configure,
  }
})
