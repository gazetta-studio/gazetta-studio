/**
 * Storage adapter utility — idempotent remove via probe-then-delete.
 *
 * Uses `exists()` to determine whether the path is present, then `rm()`
 * only when it is. This delegates the "is it missing?" decision to the
 * provider's own `exists()` implementation — no cross-provider error-
 * shape matching needed.
 *
 * Why probe-then-delete instead of try/catch:
 * - `exists()` is already part of the StorageProvider contract and every
 *   provider knows how to answer it correctly for its backend.
 * - Matching raw error messages (`ENOENT`, `NoSuchKey`, etc.) across four
 *   providers is fragile and accumulates drift as providers version.
 * - A TOCTOU race (file deleted between probe and rm) just means `rm()`
 *   throws, and the caller sees a real error — acceptable because the
 *   race is vanishingly rare in our single-writer model (the admin is the
 *   only writer on source content during v1).
 *
 * When the storage interface grows a typed `StorageNotFoundError`
 * (separate PR — retrofit across all four providers + all existing `rm`
 * callers), this helper becomes a one-liner try/catch. Until then, the
 * probe is the honest abstraction boundary.
 */
import type { StorageProvider } from '../types.js'

/**
 * `rm(path)` that swallows "already missing" — probes with `exists()`
 * first. Returns `true` if a file was actually removed, `false` if it
 * was already gone. Callers that care can distinguish.
 */
export async function rmIgnoreMissing(storage: StorageProvider, path: string): Promise<boolean> {
  if (!(await storage.exists(path))) return false
  await storage.rm(path)
  return true
}
