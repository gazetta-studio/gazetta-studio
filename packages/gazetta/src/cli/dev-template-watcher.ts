import { stat } from 'node:fs/promises'

/**
 * Default window during which a template file's mtime is considered
 * recent enough for the watcher to treat the event as a real edit.
 *
 * 1 second is comfortable headroom over filesystem mtime resolution
 * (1ns on ext4/APFS, 100ns on NTFS) and over the latency between an
 * edit landing and node:fs.watch firing on every supported OS. Outside
 * the window we treat the event as spurious — typically a kernel-
 * delayed metadata flush for a file that was written before the
 * watcher began observing it (#286 cp-r case in e2e setup).
 */
export const TEMPLATE_RECENT_CHANGE_WINDOW_MS = 1000

/**
 * Decide whether a watcher event for `fullPath` should fire a reload.
 *
 * The dev server's template watcher receives spurious inotify events
 * for files written before the watcher registered — most reliably when
 * an e2e test fixture does a worker-scoped `cp -r` of the starter
 * project (#286). The events arrive seconds-to-minutes after the
 * write, with the file's original mtime intact. Firing notifyReload()
 * for each closes any open admin UI mid-interaction.
 *
 * Real edits update mtime to ~now. The age check lets them through
 * while suppressing stale flush events. Stat failures (file deleted
 * between event and check) are treated as real changes so deletion
 * still triggers a reload.
 */
export async function isTemplateEventRecent(
  fullPath: string,
  recentWindowMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const stats = await stat(fullPath)
    return now - stats.mtimeMs < recentWindowMs
  } catch {
    return true
  }
}
