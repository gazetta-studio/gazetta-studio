/**
 * `nullAltAdapter` — the safe default returned by the factory when no
 * adapter is configured for a target.
 *
 * # Why this exists (vs. the factory returning null)
 *
 * The factory `buildAltAdapter(target)` could return `AltTextAdapter |
 * null`, forcing every consumer to null-check. That would be the
 * stub-on-the-interface anti-pattern in disguise — every caller
 * writes `if (adapter) { ... }`, which is dead code in 99% of cases
 * (the suggester wraps the adapter and handles the unconfigured case
 * via `available()` returning false).
 *
 * Instead, the factory always returns an `AltTextAdapter`. When
 * unconfigured, it returns this null implementation: `supports()`
 * always false, `generate()` throws `AIAdapterUnavailableError` if
 * ever called. The suggester's `available(mime)` checks `supports`
 * first and returns false — so `generate` is never reached on the
 * null adapter in practice. The throw is a defense-in-depth signal
 * that something has gone wrong if it IS reached.
 *
 * This is the LSP validation seam: a real adapter, full contract
 * surface, no nulls in the type system. Tests can substitute it for
 * any consumer and verify the consumer handles "unavailable" correctly
 * via `supports`-returns-false rather than via null-checks.
 *
 * # SOLID
 *
 *   - LSP: full contract; `supports`/`generate` return real values
 *   - SRP: single concern — represent "no adapter configured"
 *   - OCP: not relevant (no extension point here)
 */
import { AIAdapterUnavailableError } from '../ai/errors.js'
import type { AltTextAdapter } from './adapter.js'

export const nullAltAdapter: AltTextAdapter = {
  name: 'null',
  supports() {
    return false
  },
  async generate() {
    throw new AIAdapterUnavailableError(
      'No AI alt-text adapter is configured. Add `altText:` to site.config.ts or set provider credentials in .env.local.',
    )
  },
}
