/**
 * Alt-text prompt policies — five `AltPromptPolicy` modules that each
 * own one dimension of prompt content.
 *
 * # Why split into five
 *
 * Per [team-preferences rule 18], "structurally correct from the
 * start". A single mega-string would be a god-string with five
 * reasons to change (task framing, style, length, locale, output
 * discipline). Splitting at the SOLID seam means:
 *
 *   - WCAG guidance update → edit `styleGuidancePolicy` only
 *   - Locale strategy change → edit `localePolicy` only
 *   - Length convention change → edit `lengthPolicy` only
 *
 * Each policy is independently testable. The composer assembles them
 * via `composePrompt(req, DEFAULT_POLICIES)`.
 *
 * # Adding a new style
 *
 * Future styles like `'marketing'` or `'technical'` extend the
 * `AltStyle` enum + add a switch arm in `styleGuidancePolicy`. Other
 * policies untouched (OCP).
 *
 * # Locale handling
 *
 * Direct generation: when locale ≠ default, ask the model to write in
 * that locale. Modern vision models are competently multilingual at
 * description tasks. Translation as a separate pipeline was rejected
 * — would require a parallel `TranslationAdapter` system before its
 * second consumer exists.
 */
import type { AltPromptPolicy, AltStyle } from './adapter.js'

/**
 * The default locale for which `localePolicy` doesn't add anything.
 * Aligned with the WCAG-grounded prompts being written in English.
 */
const DEFAULT_LOCALE = 'en'

/**
 * Policy 1 — frame the task. Sets the model's frame: this is alt
 * text generation following web-accessibility conventions, not
 * caption generation.
 */
export const taskFramingPolicy: AltPromptPolicy = () =>
  `You are writing alt text for a webpage image, following WCAG 2.1 guidelines.`

/**
 * Policy 2 — style guidance per `request.style`. Currently only
 * `'descriptive'`; extending the enum adds a switch arm here.
 *
 * The descriptive guidance steers the model away from common
 * caption-style patterns ("Image of...", "A photograph of...") and
 * toward direct description.
 */
export const styleGuidancePolicy: AltPromptPolicy = req => {
  const style: AltStyle = req.style
  switch (style) {
    case 'descriptive':
      return `Describe what's visually present and meaningful. Be specific and concrete. Don't start with "image of" or "picture of" — write the description directly.`
  }
}

/**
 * Policy 3 — length cap as model guidance. Soft instruction; the
 * suggester doesn't enforce truncation. WAI-ARIA convention is 125
 * chars; per-call override via `request.maxChars`.
 */
export const lengthPolicy: AltPromptPolicy = req => `Maximum ${req.maxChars} characters.`

/**
 * Policy 4 — locale instruction. Empty string when locale is the
 * default (composer drops empty-string policies; the prompt has one
 * fewer paragraph), non-empty otherwise.
 *
 * When locale ≠ 'en', the model writes the description in that
 * language directly. No translation step.
 */
export const localePolicy: AltPromptPolicy = req => {
  if (req.locale === DEFAULT_LOCALE) return ''
  return `Write the description in ${req.locale}.`
}

/**
 * Policy 5 — output discipline. Clamp the model's tendency to add
 * preamble or wrapper quotes around its answer. Last in the order
 * because it's the closing instruction.
 */
export const outputDisciplinePolicy: AltPromptPolicy = () => `Output the description only, no preamble or quotes.`

/**
 * Default policy set, in composition order. Most prompt-tuning lives
 * in editing the policies above; the order here changes only when
 * paragraph priority changes (rare).
 *
 * Callers can pass a custom array for one-off requests, but the
 * default is what every alt-text generation uses in production.
 */
export const DEFAULT_ALT_PROMPT_POLICIES: readonly AltPromptPolicy[] = [
  taskFramingPolicy,
  styleGuidancePolicy,
  lengthPolicy,
  localePolicy,
  outputDisciplinePolicy,
]
