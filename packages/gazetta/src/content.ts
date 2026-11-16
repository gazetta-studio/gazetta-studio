import { marked } from 'marked'
import { contentJsonSchema, mapContentStrings } from './content-schema-walk.js'
import { sanitizeContentHtml } from './content-sanitize.js'

/**
 * Prepare content for a template: Markdown fields become HTML, and Markdown
 * and rich-text fields are sanitized, at any depth (objects and list items
 * included). Other values pass through unchanged.
 *
 * A schema that can't be read throws, naming the template: rendering its
 * fields unsanitized would publish whatever HTML they hold
 * (design-content-trust.md Q2).
 */
export function processContent(
  content: Record<string, unknown> | undefined,
  schema: unknown,
  templateName?: string,
): Record<string, unknown> | undefined {
  if (!content || !schema) return content
  const root = contentJsonSchema(schema, templateName)
  return mapContentStrings(content, root, ({ value, formats }) => {
    if (formats.has('markdown')) return sanitizeContentHtml(marked(value, { async: false }))
    if (formats.has('richtext')) return sanitizeContentHtml(value)
    return value
  }) as Record<string, unknown>
}
