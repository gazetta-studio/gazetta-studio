import type { StorageProvider } from '../../types.js'
import { contentJsonSchema, mapContentStrings, type JsonSchema } from '../../content-schema-walk.js'
import { findScript } from '../../content-sanitize.js'
import { unsafeAddressScheme } from '../../unsafe-address.js'
import { findTemplateFile, loadTemplate } from '../../template-loader.js'
import { componentsOf, touchedComponents, type TouchedComponent } from '../touched-components.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

const NAME = 'script-in-text'

/**
 * Script and unsafe addresses in content fields that templates insert as
 * plain text (design-content-trust.md Q2, Q3). Markdown and rich-text fields
 * are skipped: the sanitizer cleans them at render. Code fields are shown as
 * code, so they are never refused; the background scan lists the ones
 * holding script as info, in case a template inserts one unescaped. File
 * fields must hold the `data:` URI the file widget writes.
 *
 * At save-delta only values the save adds are refused, so an item that
 * already holds script still saves when another field is edited. The
 * background scan reports every value, which is how existing content shows
 * in Site health.
 *
 * Which field is which comes from the same schema walk `processContent`
 * uses, so the check and the sanitizer can't disagree. Components whose
 * template is missing, won't load or whose schema can't be read are left to
 * the validators that report those.
 */
export const scriptInText: Validator = {
  source: 'gazetta',
  name: NAME,
  stages: ['save-delta', 'background'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site, storage } = input
    const templatesDir = site.templatesDir
    if (!templatesDir) return []
    const schemas = new SchemaLookup(storage, templatesDir)

    if (scope.kind === 'save-delta') {
      const stored = new Map<string, TouchedComponent>()
      for (const c of componentsOf(scope.before)) stored.set(c.path, c)
      const issues: Issue[] = []
      for (const c of touchedComponents(scope.before, scope.after)) {
        const root = await schemas.get(c.template)
        if (!root) continue
        const before = stored.get(c.path)
        issues.push(
          ...findIssues(scope.item.itemPath, c, root, 'save')
            .filter(({ value, issue }) => !(before && valueAt(before.content, issue.field) === value))
            .map(f => f.issue),
        )
      }
      return issues
    }

    if (scope.kind !== 'background') return []
    const issues: Issue[] = []
    for (const c of componentsOf(scope.manifest)) {
      const root = await schemas.get(c.template)
      if (root) issues.push(...findIssues(scope.item.itemPath, c, root, 'background').map(f => f.issue))
    }
    return issues
  },
}

/** Each template's converted schema, loaded once per validation run; null when it can't be read. */
class SchemaLookup {
  private readonly cache = new Map<string, Promise<JsonSchema | null>>()
  constructor(
    private readonly storage: StorageProvider,
    private readonly templatesDir: string,
  ) {}

  get(template: string): Promise<JsonSchema | null> {
    let found = this.cache.get(template)
    if (!found) {
      found = this.load(template)
      this.cache.set(template, found)
    }
    return found
  }

  private async load(template: string): Promise<JsonSchema | null> {
    if (!(await findTemplateFile(this.templatesDir, template))) return null
    try {
      const { schema } = await loadTemplate(this.storage, this.templatesDir, template)
      return schema ? contentJsonSchema(schema, template) : null
    } catch {
      return null
    }
  }
}

/** The `data:` URI the rjsf file widget writes: `data:<type>[;name=<name>];base64,<data>`. */
const FILE_VALUE = /^data:[^;,]*(?:;name=[^;,]*)?;base64,[A-Za-z0-9+/=]*$/

/** What to remove from a file field's value: its scheme, or the whole value when it has none. */
function badFileValue(value: string): string | null {
  if (value === '' || FILE_VALUE.test(value)) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]
  return scheme ? `${scheme.toLowerCase()}:` : value
}

function findIssues(
  itemPath: string,
  component: TouchedComponent,
  root: JsonSchema,
  stage: 'save' | 'background',
): Array<{ value: string; issue: Issue }> {
  const out: Array<{ value: string; issue: Issue }> = []
  mapContentStrings(component.content, root, ({ path, value, formats, label }) => {
    if (formats.has('markdown') || formats.has('richtext')) return value
    const field = path.join('.')
    const name = label ?? (field || 'content')
    const issue = (what: string, severity: Issue['severity'], message: string): void => {
      out.push({
        value,
        issue: {
          validator: NAME,
          severity,
          message,
          itemPath,
          ...(component.path ? { contentPath: component.path } : {}),
          ...(field ? { field } : {}),
          subject: what,
        },
      })
    }

    if (formats.has('code')) {
      const script = findScript(value)
      if (stage === 'background' && script.length) {
        const what = script.join(', ')
        issue(what, 'info', `${name} holds script (${what}). It shows as code only if the template escapes it.`)
      }
      return value
    }

    const what = formats.has('data-url')
      ? badFileValue(value)
      : (unsafeAddressScheme(value) ?? (findScript(value).join(', ') || null))
    if (what === null) return value
    issue(
      what,
      'error',
      stage === 'save'
        ? `Script isn't allowed in ${name}: remove ${what}.`
        : `${name} holds script (${what}). Remove it before the next save of this field.`,
    )
    return value
  })
  return out
}

/** The value at a dot-joined field path, or undefined. */
function valueAt(content: unknown, field: string | undefined): unknown {
  if (!field) return content
  let current: unknown = content
  for (const part of field.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
