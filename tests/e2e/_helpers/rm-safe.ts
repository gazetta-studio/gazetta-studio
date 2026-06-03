import { rm } from 'node:fs/promises'

/**
 * The dev server keeps writing reverse-dep sidecars
 * (`.gazetta/fragment-deps/{frag}/{src}`) while scenarios wipe target
 * dirs between tests, so plain `fs.rm` races its own `rmdir` against
 * a new file appearing and throws `ENOTEMPTY`. `maxRetries` opts into
 * Node's built-in retry on ENOTEMPTY/EBUSY/EMFILE/EPERM.
 */
export async function rmSafe(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
