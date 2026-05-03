/**
 * Generic prompt composer — assembles a final prompt string from an
 * ordered list of `PromptPolicy<T>` functions, where `T` is the typed
 * request shape for the calling task.
 *
 * # Why generic over `T`
 *
 * Each AI task has its own typed request (alt-text has `AltRequest`
 * with `locale`, `maxChars`, `style`; future translation will have its
 * own with source/target language pairs, formality, etc.). The
 * composer doesn't need to know task-specific fields — it just calls
 * each policy in order and joins the non-empty results.
 *
 * Putting the composer in `ai/` (not in `alt/`) means the second task
 * doesn't reimplement composition. Each task contributes its own
 * `PromptPolicy<TaskRequest>` modules that import this composer.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "ordered policies → final prompt string"
 *   - OCP: callers pass their own policy array; the default policy set
 *     is the task's responsibility, not this module's
 *   - LSP: every policy is `(req: T) => string`; trivially substitutable
 *   - DIP: tasks depend on this generic composer, not on each other
 *
 * # Empty-string convention
 *
 * Policies that don't apply (e.g., the locale policy when locale is
 * the default 'en') return an empty string. The composer filters these
 * out before joining, so empty paragraphs don't appear in the final
 * prompt. This keeps each policy decision local — no callers need to
 * reason about "should I include this policy?"
 */

/**
 * One dimension of prompt content. A function from a typed request to
 * a string paragraph. Empty string means "this policy doesn't apply
 * for this request" and is dropped before assembly.
 */
export type PromptPolicy<TRequest> = (req: TRequest) => string

/**
 * Assemble policies into a prompt. Joins non-empty results with two
 * newlines (paragraph break) — model providers parse this as natural
 * structure. Order matters: callers pass the array in the order they
 * want paragraphs to appear.
 *
 * Tests can pass a custom policy array to validate composition without
 * coupling to any task's default set.
 */
export function composePrompt<TRequest>(req: TRequest, policies: readonly PromptPolicy<TRequest>[]): string {
  return policies
    .map(policy => policy(req))
    .filter(paragraph => paragraph.length > 0)
    .join('\n\n')
}
