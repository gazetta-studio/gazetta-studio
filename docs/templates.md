# Templates

A template is a TypeScript function that returns `{ html, css, js }`. Every template exports a Zod schema for its content — the CMS builds the editing form from it. Templates live at `templates/<name>/index.ts` (or `index.tsx` for JSX).

```ts
// templates/hero/index.ts
import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Page title'),
  subtitle: z.string().optional().describe('Subtitle text'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: html`<section class="hero">
  <h1>${content?.title ?? ''}</h1>
  <p>${content?.subtitle ?? ''}</p>
</section>`,
  css: `.hero { text-align: center; padding: 4rem 0; }
.hero h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
.hero p { color: #666; font-size: 1.25rem; }`,
  js: '',
})

export default template
```

Build `html` with the `html` tag from `gazetta`: it escapes every value you put in it, so text an author types shows as text and can't add markup or script to the page. See [Escaping content](#escaping-content).

## The template contract

The renderer calls the default export with a single params object:

| Param | Type | Description |
|-------|------|-------------|
| `content` | `T`, optional | The component's content, validated against `schema` |
| `children` | `RenderOutput[]`, optional | The rendered output of child components, in order |
| `params` | `Record<string, string>`, optional | Route parameters, on [dynamic routes](./pages-and-fragments.md#dynamic-routes) |
| `locale` | string | Active locale code (e.g. `'fr'`, `'en'`) — always provided by the renderer, defaults to the site's locale or `'en'` |

The function returns a `RenderOutput` or a `Promise<RenderOutput>`.

A template module exports only `default` and `schema` — the CMS generates the editing form from `schema`. To replace the form with a custom editor, add a separate file under `admin/editors/`; see [Custom editors](./customize-editor.md#custom-editors).

Saving checks every component it adds or changes against its template's schema, whether the save comes from the admin, a script or an agent: content that doesn't fit is refused, with the field and the component named. Components the save doesn't change aren't checked, so content an earlier schema change made invalid still saves when you edit something else, and Site health lists it. A template that exists but fails to load refuses saves of components that use it.

The admin's preview shows each page in a sandboxed frame with an origin of its own. Template scripts run there, but can't use cookies, `localStorage`, form submits, pop-ups or dialogs such as `alert()`; on the published site they can.

## Template fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `html` | string | Yes | HTML markup |
| `css` | string | Yes | CSS (scoped per component automatically) |
| `js` | string | Yes | Client-side JavaScript (`''` for static components) |
| `head` | string | No | Content for `<head>` — favicons, fonts, meta tags |

The CSS scoping is automatic: the renderer prefixes every selector with a `[data-gz="<hash>"]` attribute selector and wraps the component's HTML in a matching container, so one component's rules don't leak into another.

`head` bubbles up the tree: the renderer joins every child's `head` into the component's own, all the way to the page. Return only the tags this template adds — the children's tags arrive on their own, and collecting them again duplicates them in the final page.

## Escaping content

Content comes from authors, scripts and agents, so a template treats it as text. The `html` tag escapes each `${...}` value: `&`, `<`, `>`, `"` and `'` become entities, in element text and in quoted attribute values alike.

```ts
import { html, raw, type TemplateFunction } from 'gazetta'

const template: TemplateFunction<Content> = ({ content }) => ({
  html: html`<article>
  <h1>${content?.title ?? ''}</h1>
  <a href="${content?.link ?? '#'}">${content?.linkText ?? ''}</a>
  <div class="body">${raw(content?.body)}</div>
</article>`,
  css: '',
  js: '',
})
```

What the tag inserts as is:

| Value | How |
|-------|-----|
| A Markdown or rich-text field | `raw(content.body)`. These fields are sanitized when the page renders: script, event handlers, forms and embeds are removed, formatting, links and images stay |
| Rendered children | `${children}`, or one child as `${children[0]}`. See [Composite templates](#composite-templates) |
| The tag's own results, and arrays of them | ``${items.map(item => html`<li>${item.label}</li>`)}``, with no `.join()` |

Use `raw()` only for Markdown and rich-text fields. A plain text field passed to `raw()` publishes whatever was typed into it. A value the tag doesn't know, such as an object with an `html` key, is escaped.

Field values stay strings, and so does `c.html` on each child. The tag returns a string object, which works wherever a string does; the renderer turns it into a plain string.

**React and Vue** escape text on their own. For a Markdown or rich-text field, React keeps using `dangerouslySetInnerHTML={{ __html: content.body }}`, Vue `v-html` or `innerHTML`: the field is already sanitized.

**Links and images.** Escaping keeps a value inside its attribute, but doesn't check where a link goes. Give `href` and `src` a `format.uri()`, `format.link()` or `format.image()` field: saving refuses `javascript:` and similar addresses in any field, and these formats give authors the right input.

## Markdown or rich text

Two field types hold formatted text. Both reach the template as sanitized HTML, so insert either with `raw()`:

| Field | Stores | Pick it for |
|-------|--------|-------------|
| `format.markdown()` | Markdown | Authors who write Markdown, and content kept in git as text that reads well in a diff |
| `format.richtext()` | HTML | Authors who want a word-processor editor: bold, links and lists from a toolbar |

```ts
import { z } from 'zod'
import { format } from 'gazetta'

export const schema = z.object({
  body: z.string().meta(format.markdown()).describe('Article body'),
  note: z.string().meta(format.richtext()).optional().describe('Side note'),
})
```

A field that holds HTML on purpose is a rich-text field, not a plain `z.string()`: saving refuses script in plain text fields, and the `html` tag escapes them.

## Frameworks

Templates can use any framework that SSR's to HTML:

**React** — save the template as `templates/<name>/index.tsx` and import React: `.tsx` templates are compiled with a JSX transform that needs React in scope:
```tsx
// templates/card/index.tsx
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const template: TemplateFunction<Content> = ({ content }) => ({
  html: renderToStaticMarkup(<Card {...content!} />),
  css: `.card { padding: 1.5rem; }`,
  js: '',
})
```

**Vue 3** — needs `npm install vue` first; `init` doesn't install Vue:
```ts
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

const template: TemplateFunction<Content> = async ({ content }) => {
  const app = createSSRApp(Quote, content ?? {})
  return { html: await renderToString(app), css: '...', js: '' }
}
```

**Interactive components** return JS that runs in the browser:
```ts
const template: TemplateFunction<Content> = ({ content }) => ({
  html: `<button id="btn">Click me</button>`,
  css: `button { padding: 0.5rem 1rem; }`,
  js: `document.getElementById('btn').addEventListener('click', () => alert('Hi'))`,
})
```

## Composite templates

Layout templates receive `children` — the rendered output of child components. Put them in the `html` tag directly, `${children}`, and the tag inserts their markup unescaped; `${c.html}` would be escaped and show as text. To split them, interpolate the parts: `${children[0] ?? ''}` and `${children.slice(1)}`. CSS and JS do not bubble: collect them from the children, or they never reach the page. `head` does bubble (see above), so a layout returns only its own additions:

```ts
// templates/page-layout/index.ts
import { z } from 'zod'
import { html, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().optional().describe('Page title'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content, children = [] }) => ({
  html: html`<main>${children}</main>`,
  css: `main { max-width: 800px; margin: 0 auto; }
${children.map(c => c.css).join('\n')}`,
  js: children.map(c => c.js).filter(Boolean).join('\n'),
  head: html`<title>${content?.title ?? ''}</title>`,
})

export default template
```

## Check a template change in CI

When you change a template's schema, content already written for it may stop fitting: a field becomes required, or a type changes. Run `gazetta validate` with `--base` in a pull request, and the pull request fails when existing content no longer fits the changed template. The report lists each page and fragment that breaks, with the field and the language version.

Only what the pull request breaks fails it. Problems the base branch already had, such as an old broken link, are listed separately as "already broken" and don't fail the run. A problem counts as the same when it's on the same item, language, component and field, and about the same thing, even if its message reads differently.

To make a breaking change on purpose, update the affected content in the same pull request: the report lists it, and the check turns green once it fits. There's no setting that lets broken content through.

**Content on targets.** Content edited on a target, such as a hotfix on production, isn't in the repository. Name the targets that hold content with `--targets production,staging`, and give the job the read credentials `gazetta publish` uses for them. A target named this way that can't be read stops the run; none is skipped. Public targets can't be named, because they hold no manifests. On a static target, missing fragments aren't checked and `--render` doesn't render it: its fragments are baked into its pages, so it stores none. Each problem on a target says how to fix it: publish that target's content back to your editing target, fix it in the pull request, and publish again.

**Templates that might throw.** The check reads content against schemas and doesn't run templates. Add `--render` to also render every page and fragment, in every language, that uses a template changed in the pull request, and fail when a template throws. Without `--base`, `--render` renders the whole site, which is slow on a large one.

A workflow to copy into `.github/workflows/template-check.yml`:

```yaml
name: Template check
on:
  pull_request:
    paths:
      - 'templates/**'
      - 'sites/**'
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # --base reads the base commit
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - run: npm ci
      - run: npx gazetta validate --base "origin/$BASE_REF" --format github
        env:
          BASE_REF: ${{ github.base_ref }}
```

`sites/**` covers each site's content and its `site.config.ts`. To check targets' content and render changed templates too, change the last step, with the environment variables your targets' storage reads:

```yaml
      - run: npx gazetta validate --base "origin/$BASE_REF" --targets production --render --format github
        env:
          BASE_REF: ${{ github.base_ref }}
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

With `--format github`, the job summary has a table per template with problems, and each broken template gets an annotation on its entry file in the pull request's diff:

> ### `hero` (`templates/hero/index.tsx`)
>
> | Item | Language | Field | Message |
> |---|---|---|---|
> | pages/home | default | hero › cta | cta: Required |
> | pages/home | fr | hero › cta | cta: Required |
> | pages/promo on production | default | hero › cta | cta: Required |
>
> - pages/promo on production doesn't fit the new `hero`: publish production → local, fix it here.

All the flags are in the [command-line reference](./cli.md#gazetta-validate-site).
