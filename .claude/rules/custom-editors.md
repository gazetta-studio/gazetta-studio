---
paths:
  - "apps/admin/**"
  - "packages/gazetta/src/editor/**"
  - "packages/gazetta/src/admin-api/**"
---

# Custom Editors and Fields

Custom editing UIs, field widgets, template switching, and the editor development workflow.

## Overview

The CMS auto-generates editor UIs from template Zod schemas using @rjsf. Templates can
override with a custom editor or add custom field widgets for specific schema properties.

| Concept | Scope | Lives in | Relationship |
|---------|-------|----------|-------------|
| Editor (custom editing UI) | Per-template | `admin/editors/` | Replaces the entire auto-generated form |
| Field (custom widget) | Reusable | `admin/fields/` | Replaces a single form field inside the @rjsf form |

## Empty Admin (No Custom Editors or Fields)

Works. The admin UI loads the default @rjsf form for all templates. `admin/editors/` and
`admin/fields/` are empty directories — no files needed. Custom editors/fields are opt-in.

## Who Creates Custom Fields

Site authors and template developers can both create custom fields. Any developer with
access to `admin/` can create editors or fields.

## Type Access

Editors import **types only** from templates via `import type` (erased at runtime, no
cross-workspace dependency). Templates export a content type:
`export type HeroContent = z.infer<typeof schema>`. Editors import it:
`import type { HeroContent } from '@templates/hero'`. The `@templates` alias is configured
in `tsconfig.json` paths.

## Gazetta Package Exports

The `gazetta` npm package provides these subpath exports:

```
gazetta              # main — TemplateFunction, format helpers, renderer
gazetta/types        # TypeScript types — EditorMount, FieldMount, etc.
gazetta/editor       # browser-only — createEditorMount, DefaultEditorForm
```

Both `admin/` and `templates/` workspaces import from `gazetta`. npm deduplicates to
one installation at the project root. `gazetta/editor` is browser-only — templates
should never import it (it pulls in React, @rjsf, Tiptap).

## Editor File Convention

Editors are flat files: `admin/editors/hero.tsx` (not `admin/editors/hero/index.tsx`).
Templates are directories: `templates/hero/index.tsx` (because templates often have
colocated files like tests or README).

Editors are typically single files — no colocated assets. If an editor grows complex
enough to need multiple files, use a directory: `admin/editors/hero/index.tsx` with
supporting files alongside. Both conventions are discovered.

## Custom Editor Naming for Subfolder Templates

Editor names mirror template paths. Template `buttons/primary` (at `templates/buttons/primary/`)
has editor `admin/editors/buttons/primary.tsx`. The directory structure inside `admin/editors/`
mirrors `templates/`.

## Custom Field Naming

Field files support subfolders like templates: `admin/fields/colors/brand.tsx` is
referenced as `{ field: 'colors/brand' }`. Flat is default, subfolders for grouping.

## Editor and Field File Extensions

Editors and fields can be `.ts`, `.tsx`, `.jsx`. Vite transforms all of them. While the
EditorMount/FieldMount contracts are framework-agnostic, editors that import `createEditorMount`
or `DefaultEditorForm` use React. Vanilla JS/TS editors (no React import) are also supported —
they use DOM APIs directly.

## Validation of Custom Editors and Fields

`gazetta validate` should check:
- Every `admin/editors/{name}.tsx` has a matching `templates/{name}/` directory
- Every `meta({ field: 'name' })` in a template schema has a matching `admin/fields/{name}.tsx`
- Orphaned editors (editor exists but template doesn't) are warnings
- Missing fields (schema references a field that doesn't exist) are errors

## Orphaned Editors

If `templates/hero/` is deleted but `admin/editors/hero.tsx` still exists, the editor
is never loaded (no template = no component = no editor mount). `gazetta validate` reports
it as a warning. The `import type` in the editor would fail TypeScript compilation, catching
it at dev time.

## Custom Editor + Custom Field Interaction

When a template has both a custom editor AND schema fields with custom fields:
- **Custom editor replaces the entire form** — custom fields inside the schema are NOT
  automatically used. The custom editor controls everything.
- **If the custom editor embeds `DefaultEditorForm`** — custom fields ARE used inside
  the embedded form. The embedded form respects `meta({ field: 'name' })` as usual.

Developers who want custom fields to work must either use no custom editor (default form)
or embed `DefaultEditorForm` in their custom editor.

## Custom Fields in Nested Schemas and Arrays

`buildUiSchema` detects `meta({ field: 'name' })` at **all levels** — top-level properties,
nested objects, and array items. Custom fields work inside:
- `z.object({ color: z.string().meta({ field: 'brand-color' }) })` — top level
- `z.object({ settings: z.object({ color: ... }) })` — nested
- `z.array(z.object({ color: ... }))` — per array item

Array items with custom fields: the field widget mounts/unmounts per item as items are
added, removed, or reordered.

## Cross-workspace Imports (Forbidden)

Templates must NOT import from `admin/` at runtime. Admin code is browser-only (React,
DOM APIs). Templates are server-only (Node, SSR).

Allowed: `import type` across workspaces (erased at compile time).
Forbidden: `import { something } from '../../admin/...'` (runtime import).

`gazetta validate` should detect and warn about cross-workspace runtime imports.

## `DefaultEditorForm` Standalone Use

`createEditorMount` and `DefaultEditorForm` from `gazetta/editor` mount a React form
into any DOM element. They work outside the admin UI — useful for embedding a schema-driven
form in custom applications. Not officially supported or tested for standalone use, but
architecturally independent of the admin's Vue shell.

## Admin UI in Dev Mode — Source vs Pre-built

In the monorepo, `gazetta dev` runs Vite against `apps/admin/` source — full HMR on admin UI.

In a site project (gazetta installed from npm), the admin SPA is **pre-built** inside the
gazetta package (`admin-dist/`). `gazetta dev` serves it as static files. No Vite needed
for the admin shell. Custom editors/fields still get HMR via Vite (they're in the developer's
project). Site developers don't modify the admin shell — they customize via editors/fields.

| Context | Admin UI | Custom editors/fields | HMR scope |
|---------|----------|----------------------|-----------|
| Monorepo | Compiled from source via Vite | Compiled from source via Vite | Everything |
| Site project (npm) | Pre-built from package | Compiled from source via Vite | Custom code only |

In site projects, `gazetta dev` runs a Vite dev server alongside the pre-built admin.
The pre-built admin loads custom editors/fields from the Vite dev server URL (e.g.
`http://localhost:3000/@site/admin/editors/hero.tsx`). Vite transforms TypeScript and
provides HMR for these files. The admin shell itself is static — no HMR on Vue components.

## Template Switching

A content author can change which template a component uses via the admin UI. If the new
template's schema is compatible (same or superset of fields), existing content transfers.
Incompatible fields are dropped (with a warning). The admin UI shows a template selector
in the component inspector.

## Dev Playground Empty State

If no custom editors or fields exist, the playground shows:

```
No custom editors or fields yet.

Create an editor:  admin/editors/{template-name}.tsx
Create a field:    admin/fields/{field-name}.tsx

See docs: gazetta.studio/docs/custom-editors
```

The playground also shows the default @rjsf form for any template — useful for testing
schemas without creating a custom editor.
