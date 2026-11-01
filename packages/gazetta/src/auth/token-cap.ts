/**
 * What a Gazetta token may do (design-agent-access.md Q12): the person's
 * capabilities, capped to editing. Publishing, deleting (purge included),
 * restoring history (undo and rollback) and approving publish requests
 * need the person's browser, and from cut 8 an elevation. Creating a
 * publish request stays allowed (Q29).
 *
 * The cap is applied where the principal is built, so routes check
 * capabilities as usual and never look for tokens themselves.
 */
import { capabilityGrants, KNOWN_CAPABILITIES } from './capabilities.js'

/** Whether a token can never hold `capability`, whatever the person's role. */
export function isWithheldFromTokens(capability: string): boolean {
  if (capability === 'publish:request') return false
  return capability.startsWith('publish:') || capability.startsWith('delete:') || capability === 'restore:history'
}

/**
 * The token's capabilities: every known concrete capability the person's
 * set grants, minus the withheld ones. Wildcards are expanded first, so
 * `*` or `publish:*` can't carry a withheld capability through.
 */
export function capTokenCapabilities(personCapabilities: ReadonlyArray<string>): string[] {
  return [...KNOWN_CAPABILITIES].filter(
    cap => !cap.endsWith('*') && !isWithheldFromTokens(cap) && capabilityGrants(personCapabilities, cap),
  )
}

/**
 * Whether a request was refused only because it came with a token: the
 * capability is one tokens can't use, and the person has it.
 */
export function deniedOnlyForToken(
  principal: { channel?: string; browserCapabilities?: ReadonlyArray<string> },
  capability: string,
): boolean {
  return (
    principal.channel === 'token' &&
    isWithheldFromTokens(capability) &&
    capabilityGrants(principal.browserCapabilities ?? [], capability)
  )
}
