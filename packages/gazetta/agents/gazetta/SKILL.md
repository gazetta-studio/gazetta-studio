---
name: gazetta
description: Work in a Gazetta project - edit pages, fragments and translations on the local target, write templates and their Zod schemas, add custom editors and fields, and check the site with gazetta validate. Use for any change under sites/, templates/ or admin/ in a project that depends on the gazetta package.
---

# Gazetta

Gazetta is a CMS that builds websites from components. A **page** is a route plus a list of components; a **fragment** is a component shared between pages (a header, a footer); a **template** is the code that renders a component. Content is plain JSON files on disk, and templates are TypeScript.

The person you work for decides what goes live. You edit files and check them; publishing, deploying and deleting are theirs (see the last section).

## Project layout

```
templates/<name>/index.ts      # a template (index.tsx for JSX)
admin/editors/<template>.tsx   # optional custom editor for one template
admin/fields/<field>.tsx       # optional custom form field
sites/<site>/site.config.ts    # the site and its targets
sites/<site>/targets/local/    # the editing target's content root
  pages/<path>/page.json       # a page; the folder path is its route
  fragments/<name>/fragment.json
```

`gazetta init` creates one site, `main`. Edit content under the editing target (`targets/local/`); other targets (`staging`, `production`) receive content only when the person publishes.

## Editing content

A page manifest:

```json
{
  "template": "page-layout",
  "content": { "title": "About", "description": "About our company" },
  "components": [
    "@header",
    { "name": "intro", "template": "text-block", "content": { "body": "<p>Hello.</p>" } }
  ]
}
```

- The route comes from the folder: `pages/about/` is `/about`, `pages/home/` is `/`, and `pages/blog/[slug]/` is `/blog/:slug`.
- `components` holds inline components (`name`, `template`, `content`) and fragment references: strings starting with `@`, such as `"@header"` for `fragments/header/fragment.json`. A bare string must be a fragment reference.
- `content` must match the template's schema (`templates/<template>/index.ts`). Read the schema before writing content.
- Images and files are asset references, `{ "_asset": "<name>" }`, pointing at the asset library; upload new assets in the admin rather than inventing names.
- Translations are whole manifests next to the default: `page.fr.json`, `fragment.fr.json`. Each has its own `template`, `content` and `components`. `gazetta translate <item> --to <locale>` creates one as a copy to translate.
- Run `gazetta dev` and open `http://localhost:3000` to preview; the admin is at `/admin`. New page folders are picked up without a restart.
- Run `gazetta validate` after editing. It exits non-zero on broken references, unknown templates and invalid manifests; `--include-quality` adds accessibility and HTML checks, `--verbose` prints every issue.

## Writing templates

```ts
// templates/hero/index.ts
import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'
import { embeddedAsset, type Content } from 'gazetta/schema'

export const schema = z.object({
  title: z.string().describe('Page title'),
  image: embeddedAsset({ accept: ['image'] }).optional().describe('Hero image'),
})

type Resolved = Content<z.infer<typeof schema>>

const template: TemplateFunction<Resolved> = ({ content }) => ({
  html: `<section class="hero"><h1>${content?.title ?? ''}</h1></section>`,
  css: `.hero { padding: 4rem 0; }`,
  js: '',
})

export default template
```

- A template module exports `default` (the render function) and `schema` (Zod), nothing else. The admin builds the editing form from the schema; `.describe()` gives each field its label.
- The render function receives `{ content, children, params, locale }` and returns `{ html, css, js, head? }` (or a promise of it). CSS is scoped to the component automatically.
- Layout templates receive `children`, the rendered output of their child components. Collect the children's `css` and `js` into your own; `head` is collected for you.
- Asset fields use `embeddedAsset()` from `gazetta/schema`; `Content<T>` turns asset references into resolved assets (`url`, `srcset`, `alt`, `width`, `height`).
- `format` from `gazetta` sets a field's widget: `z.string().meta(format.markdown())`, `format.richtext()`, `format.textarea()`, `format.color()`, `format.field('<custom-field>')` and others.
- Escape text you put into HTML attributes or markup yourself; templates insert strings as they are.
- Any framework that renders to an HTML string works: React with `renderToStaticMarkup` in an `index.tsx`, Vue with `renderToString`.

## Custom editors and fields

- A custom editor replaces a template's whole form: `admin/editors/<template>.tsx` default-exports an `EditorMount` (`mount(el, props)`, `unmount(el)`) from `gazetta/types`. Reuse the generated form inside it with `DefaultEditorForm` from `gazetta/editor`.
- A custom field replaces one input: `admin/fields/<name>.tsx` default-exports a `FieldMount` from `gazetta/types`; a schema uses it with `format.field('<name>')`.

## Never run these; ask the person

These publish or deploy, delete content, or rewrite a target's history. Don't run them, and don't call them through the admin's API; tell the person what you would run and why, and let them do it.

Commands:
- `gazetta publish`
- `gazetta deploy`
- `gazetta undo`
- `gazetta rollback`
- `gazetta archive purge`
- `gazetta state remove`

Admin API routes:
- `POST /api/publish`
- `POST /api/publish/stream`
- `POST /api/fetch`
- `POST /api/history/undo`
- `POST /api/history/restore`
- `DELETE /api/pages/:name`
- `DELETE /api/pages/:name/purge`
- `DELETE /api/fragments/:name`
- `DELETE /api/fragments/:name/purge`
- `DELETE /api/assets/:name`
- `POST /api/assets/:name/replace-with/:newName`

Also never approve a publish or review request on the person's behalf. Editing files, saving, archiving, restoring from the archive, renaming and uploading are fine: the person can undo them.
