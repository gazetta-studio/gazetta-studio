import { contentJsonSchema, UnreadableSchemaError } from '../../content-schema-walk.js'
import { findTemplateFile, loadTemplate } from '../../template-loader.js'
import { componentsOf } from '../touched-components.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

/**
 * Names the templates whose schema can't be converted to JSON Schema, even
 * tolerantly: their content can't be sanitized, so a page using one fails to
 * render rather than publishing unsanitized HTML (design-content-trust.md
 * Q2). One issue per template per item, before anyone tries to publish it.
 * A template that won't load at all is schema-conformance's to report.
 */
export const unreadableSchema: Validator = {
  source: 'gazetta',
  name: 'unreadable-schema',
  stages: ['background'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, storage } = input
    const templatesDir = site.templatesDir
    if (scope.kind !== 'background' || !templatesDir) return []
    const templates = new Set(componentsOf(scope.manifest).map(c => c.template))
    const issues: Issue[] = []
    for (const name of templates) {
      if (!(await findTemplateFile(templatesDir, name))) continue
      let schema: unknown
      try {
        schema = (await loadTemplate(storage, templatesDir, name)).schema
      } catch {
        continue
      }
      if (!schema) continue
      try {
        contentJsonSchema(schema, name)
      } catch (err) {
        if (!(err instanceof UnreadableSchemaError)) throw err
        issues.push({
          validator: 'unreadable-schema',
          severity: 'error',
          message: `Template "${name}": its schema can't be read, so this ${scope.item.kind} won't render. ${err.reason}`,
          itemPath: scope.item.itemPath,
          subject: name,
        })
      }
    }
    return issues
  },
}
