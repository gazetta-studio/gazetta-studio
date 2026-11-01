/**
 * A conditional storage write that didn't happen because its condition
 * failed: with `ifNoneMatch: '*'`, the file already existed. The existing
 * file is unchanged (#1554).
 */
export class StorageConditionalFailedError extends Error {
  readonly path: string

  constructor(path: string, options?: { cause?: unknown }) {
    super(`${path} already exists`, options)
    this.name = 'StorageConditionalFailedError'
    this.path = path
  }
}
