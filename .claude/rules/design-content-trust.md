# Content trust and Markdown fields

What people who can save may put on the published site, where that rule is enforced, and how `format.markdown()` becomes a real editor. Resolves [#1484](https://github.com/gazetta-studio/gazetta-studio/issues/1484) (content trust) and [#1483](https://github.com/gazetta-studio/gazetta-studio/issues/1483) (Markdown in the admin), designed in one round because every Markdown option takes on the content-trust answer.

**Status**: design pass complete (2026-10-30), grilled Q1–Q8. Implementation not started.

**Companion docs:**
- Discovery research: [#1484](https://github.com/gazetta-studio/gazetta-studio/issues/1484) and [#1483](https://github.com/gazetta-studio/gazetta-studio/issues/1483) (discovery-prep-bot comments, 2026-10-30)
- [`design-media.md`](design-media.md): SVG sanitizing with DOMPurify; images written inside Markdown aren't tracked
- [`design-validation.md`](design-validation.md): the save-delta and background stages the save check runs at
- [`design-auth-rbac.md`](design-auth-rbac.md): no new capability (Q1)
- [`sidecars.md`](sidecars.md): `RENDER_FORMAT_VERSION`, raised in cut 1
- [`design-tutorial.md`](design-tutorial.md): `docs/templates.md` (tutorial cut 2) is where template developers learn escaping
- [`css-theming.md`](css-theming.md): the editor uses the admin tokens through `.gz-editor`

## Scope

**In v1:**
- Markdown and rich-text fields come out as sanitized HTML; script, event handlers, forms and embeds are removed for everyone
- An escaping `html` template tag exported by `gazetta`, taught by the starter and `docs/templates.md`
- Save refuses script in plain text fields (code fields excepted), and `javascript:`, `vbscript:` and `data:` addresses (except raster images; file fields excepted); Site health lists existing cases
- Markdown converted in nested fields (objects, list items), not only top-level ones
- `format.markdown()` becomes a Tiptap editor that saves Markdown, with a Formatted/Markdown toggle

**Out of v1:**
- Pages written as `.md` files, editing `.md` files in the admin, and a `.md` import (Q5)
- Tracking images written inside Markdown (`design-media.md`)
- A raw HTML field type (`format.html()`, Q4)
- Whether the admin and the site may share an origin in production (Open questions)

**Non-goals:**
- Script or embeds from content. They come through templates (Q1).

## Discovery

Read from code on main, 2026-10-30:

1. `processContent` (`packages/gazetta/src/content.ts`) runs `marked` on top-level `format: 'markdown'` fields only, with no sanitizer; a Markdown field inside an object or list item reaches the template as raw Markdown.
2. String templates interpolate raw (`text-block`: `<p>${content.body ?? ''}</p>`), as `docs/templates.md`'s first example teaches; React templates escape (`renderToStaticMarkup`).
3. gazetta.studio's `text` template takes HTML on purpose (`body: z.string().describe('Text content (HTML allowed)')`); its one use, the blog page, holds `<p>`, `<strong>` and `<a>` only.
4. `format.richtext()` is a Tiptap 3 editor that stores HTML (`editor/mount.tsx`); `format.markdown()` is a text box.
5. `isomorphic-dompurify` is already a dependency (SVG uploads, `assets/svg-sanitize.ts`).

## Locked decisions

### Q1 — Safe HTML for everyone; script only through templates

Fields that accept HTML or Markdown keep formatting, links and images, but script and event handlers are removed for every role. Scripts and embeds (forms, widgets) come only through templates.

Decided: maintainer, 2026-10-30 (#1579)

Publish approval and a CSP (#362) are therefore not what stops script from content; they stay defence in depth. Follows from Q1.

| Rejected | Why |
|---|---|
| Anything, as today, documented as the trust model | One pasted snippet runs script on the live site, and every site copied from the starter inherits it |
| Role-gated raw HTML (WordPress's `unfiltered_html`) | The same paste behaves differently by role; one more capability; admins can still publish pasted script by accident |
| No HTML in content: everything escaped, formatting only through structured fields | Rich text would need structured storage, Markdown's inline HTML stops working, and existing templates break |

### Q2 — Field type decides; templates escape plain text; save refuses script

Markdown and rich-text fields are sanitized when rendered (`processContent`, DOMPurify) and reach the template as HTML. The sanitizer removes forms, form controls, `iframe`, `object`, `embed` and the `<style>` element as well as script and event handlers, since DOMPurify keeps forms and `<style>` by default (follows from Q1). Plain text fields are escaped by templates: `gazetta` exports an escaping `html` tag (`` html`<h1>${content.title}</h1>` ``), which the starter and `docs/templates.md` use. As a backstop, saving refuses script or event handlers typed into a plain text field: a save-delta validator, error severity, using DOMPurify to find what it would remove. Text such as `a < b` or `<b>` saves and shows as text.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| The same without the save check | One template that forgets to escape publishes script |
| The renderer escapes every plain string | React templates escape again, so readers see `&amp;`; the result depends on the template's framework |
| Sanitize every string on save | The same double-encoding, and it rewrites what the author typed |

Markdown and rich-text fields go into an `` html`` `` template through an exported `raw()` helper (`` html`<article>${raw(content.body)}</article>` ``), which inserts the sanitized HTML unescaped. Field values stay strings, so React templates keep using `dangerouslySetInnerHTML`. A template that forgets `raw()` shows the tags as text, which is visible and safe.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Return those fields as a marked-safe value that `` html`` `` inserts unescaped | Fields stop being strings (`.length`, string methods, React needs `String()`): a breaking change for every template using them |
| Build those fields outside the tag (`` html`…` + `<article>${content.body}</article>` ``) | Two styles in one template, and moving the field inside the tag escapes it |

Rendered children go into `` html`` `` unescaped: the tag inserts `RenderOutput` values and arrays of them as is, so composite templates write `` html`<header>${children}</header>` ``. `c.html` stays a string. Cut 3 updates the ten composite templates (six starter, four gazetta.studio) and the composite example in `docs/templates.md`, which today write `${children.map(c => c.html).join('\n')}` (and `two-column`, `${sidebar?.html ?? ''}` and `${main.map(c => c.html).join('\n')}`); they interpolate the rendered values themselves (`${children}`, `${sidebar ?? ''}`, `${main}`), since a `${c.html}` string inside the tag shows as text. The renderer marks the children it passes, so a content object that merely has an `html` key is still escaped.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| `raw()` for children (`${raw(children.map(c => c.html).join(''))}`) | The same ten templates change, and developers meet `raw()` in two unrelated places |
| The renderer marks each child's `html` as already rendered | `.join()` returns a plain string, so the mark is lost before the tag sees it; keeping it would make `c.html` an object, the breaking change rejected for fields |

The tag also inserts its own results as is: `` html`` `` returns a marked value that still works as a string, and arrays of such values are inserted too, so lists build without `raw()` (`` html`<nav>${links.map(l => html`<a href="${l.href}">${l.label}</a>`)}</nav>` ``).

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| `raw()` around composed lists (`${raw(items.map(…).join(''))}`) | Lists are the commonest template pattern; six templates build them this way today |

The sanitizer keeps `target` and `rel` on links, so rich-text links still open in a new tab; cut 1's tests pin a rich-text link's round-trip.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Drop `target`, DOMPurify's default | Every rich-text and Markdown link would stop opening in a new tab after cut 1 |

The sanitizer also removes the `style` attribute; formatting comes from templates' CSS. Tiptap emits no inline styles.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Keep the attribute and strip only unsafe CSS (network-loading `url()`, `position:fixed`), as `svg-sanitize.ts` does for `url()` | A list of unsafe CSS to maintain, for formatting templates already provide |

The save check also refuses a string value that is a `javascript:`, `vbscript:` or `data:` address (except `data:image/png`, `jpeg`, `gif`, `webp` and `avif`, the raster formats `design-media.md` serves as images, base64 or percent-encoded; `svg+xml` stays out), with the same banner. The allowed formats are one exported constant that `svg-sanitize.ts` uses too. It reads the value as a browser reads an address: entities decoded, tabs and newlines removed, leading control characters and spaces ignored, scheme case-insensitive, so `java	script:` and `&#106;avascript:` are refused too. Links inside Markdown and rich-text fields are left to the sanitizer. `docs/templates.md` says `href` and `src` take `format.uri()`, `format.link()` or `format.image()` fields. A plain-text address like `javascript:alert(1)` contains nothing for escaping or DOMPurify to change, yet runs when clicked.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Leave addresses to templates, documented | The starter's `card` template puts a plain text field into `href`, and `format.link()` and `format.image()` fields (the starter's `showcase`) don't restrict schemes either (`formats.ts`) |
| Allow any `data:image` | `data:image/svg+xml` would pass without SVG sanitizing, and two allow-lists would drift |
| `svg-sanitize.ts`'s list (png, jpeg, gif, webp, base64 only) | Chosen for images inside SVGs; it would refuse AVIF, which `design-media.md` lists as supported, and percent-encoded images, with a banner naming nothing that is script |
| Upload's list today (png, jpeg, gif) | WebP would leave the SVG sanitizer's list; HEIC and TIFF are converted on upload and never served, so they stay out either way |

The save check, script and addresses alike, walks every string value, nested objects and list items included, as the sanitizer does.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Top-level fields only | The links that motivated the address check sit in list items (the starter's `nav`, gazetta.studio's `nav-bar` and `link-list`) |

A `format.file()` field must hold `data:<type>[;name=<encoded name>];base64,…`, the shape its widget writes (rjsf adds the file name); any other value is refused with the same banner. This replaces skipping file fields, which would have let `javascript:` through them.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Remove `format.file()` | Not needed to keep the check correct; files can still go through the asset library |
| Skip file fields entirely | A script or the MCP server could save `javascript:alert(1)` in one, and a template linking the file runs it on click |
| Skip only the `data:` rule for file fields | Accepts values the widget never writes |
| Require `data:<type>;base64,…` without `;name=` | Refuses every file the widget saves |

`format.code()` fields skip the whole save check: their content is code shown as text, and templates escape code fields like plain text, so once a template does (cut 3), an example containing `<script>` shows and never runs. The background scan lists code fields holding script as info in Site health, so a template that still inserts one raw is visible.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Check code fields too | An HTML or JS example containing `<script>` or `onclick` could never be saved |
| No Site health listing, only a Migration note | A template inserting a code field raw publishes its script with no warning anywhere |

Schemas are converted tolerantly (`z.toJSONSchema` with `unrepresentable: 'any'`), so templates with `z.date()`, `.transform()`, `z.custom()` or `z.bigint()` fields keep rendering with their other fields sanitized. If a schema still can't be read, its page fails to render with an error naming the template, instead of publishing its fields unsanitized (`processContent` returns content unchanged today). A validator, in Site health and `gazetta validate`, names any such template before publish.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Escape every string field of that template | The page renders with rich text showing its tags |
| Keep failing open, documented | Rare, but the one way unsanitized HTML would still reach a page |
| Fail closed on zod's default conversion, with the validator | It throws on `z.date()`, `.transform()`, `z.custom()` and `z.bigint()`, so templates that publish today would stop publishing |

### Q3 — Existing content: sanitize at render, list the rest in Site health

Manifests stay as they are. Cut 1 raises `RENDER_FORMAT_VERSION`, so the next publish of everything re-renders every page once (Migration: publish everything once after cut 1; a publish of only some items leaves the rest's old HTML live) with Markdown and rich-text fields sanitized. The save check also runs in the background scan and lists plain text fields that already hold script in Site health. Save-delta refuses only script the current edit adds, so editing another field of the same item still saves.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Sanitize only from each item's next save | Script stays on the live site until someone happens to edit each item, with no list of affected items |
| A one-time command that rewrites every manifest | Edits content the author never touched, and adds history noise, for fields render-time sanitizing already covers |

### Q4 — Plain text fields that hold HTML on purpose move to rich text

Such fields switch to `format.richtext()`: gazetta.studio's `text` template, and any starter template whose content holds HTML (cut 3 checks; templates whose content is plain text switch to `` html`` `` instead). Stored HTML is unchanged and authors edit it in the existing rich-text editor.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| A new `format.html()` field (raw HTML, sanitized at render) | A second HTML field type next to rich text, and authors edit tags by hand; no current content needs markup outside Tiptap's set (Future directions) |

Tiptap keeps only the markup it supports, so the first edit of such a field can drop unsupported tags or classes; today's blog body has none.

### Q5 — Markdown in the admin means better Markdown fields

`format.markdown()` becomes a real editor (Q7, Q8), Markdown in nested fields is converted, and `docs/templates.md` says when to pick Markdown or rich text (Q6).

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| The same plus a one-way `.md` import command | Helps only migrations, which nobody has asked for yet (Future directions) |
| Pages written as `.md` with frontmatter | Reopens the website plan's deferral and adds a second manifest format to the loader, hash, compare, publish, locale suffixes, validators and history, with no named trigger |
| Editing `.md` files in the admin | A new item kind outside pages and fragments, for gazetta.studio's docs, which stay generated from `docs/` (#1289) |

### Q6 — Keep both rich fields, and document when to pick each

`format.markdown()` (stores Markdown) and `format.richtext()` (stores HTML) both stay. `docs/templates.md` says: Markdown for authors who write Markdown or content kept in git as text; rich text for authors who want a word-processor editor. Both are sanitized at render (Q1).

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Rich text canonical, Markdown deprecated (Decap's direction) | Drops the field Q5 improves and migrates starter content |
| Markdown canonical: rich text stores Markdown | Converting stored HTML to Markdown loses what Markdown can't express (tables, classes, spans) |

### Q7 — The Markdown editor is Tiptap with `@tiptap/markdown`

`@tiptap/markdown` (MIT; 3.32.1 on npm, 2026-10-28) adds Markdown storage to the Tiptap 3 stack the rich-text field already uses, so the two fields share styling and dark/light handling. Before the editor ships, cut 4 checks that untouched Markdown comes back byte-identical, and that the editor works with a keyboard, with a screen reader and in Arabic (RTL).

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Our own toolbar on the text box, preview with `marked` | Our own selection, shortcut and accessibility code to maintain, and no formatted editing for authors who don't know Markdown |
| EasyMDE (MIT) | Built on CodeMirror 5, the older line; its styling must be mapped to the admin tokens; RTL unchecked |
| Milkdown (MIT) | A second ProseMirror-based editor next to Tiptap, and the largest of the four offered (3.5 MB unpacked) |
| DoMD (`@do-md/core-react`) | Its package is GPL-3.0-only with extra permissions, not MIT |
| MDXEditor (MIT) | A second rich-text engine (Lexical) next to Tiptap |
| `@uiw/react-md-editor` (MIT) | 4.3 MB unpacked, the largest package the research found |

### Q8 — A Formatted/Markdown toggle; untouched fields are never rewritten

The field shows formatted text by default, with a toggle to the raw Markdown: a plain text box, saved exactly as typed. The choice is remembered per browser. The editor writes the field only after an edit, so opening and saving a page doesn't reformat its Markdown. Switching from Markdown to Formatted can normalise syntax (for example `*` lists become `-`), and the toggle says so. The Formatted view reads Markdown with `@tiptap/markdown` while published pages use `marked`; cut 4 compares the two before shipping, and the toggle note names any known differences.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Formatted only | No way to keep exact Markdown or to edit what Tiptap can't show (tables with multi-line cells, inline HTML) |

## UX check

- **Actors:** content authors (the Markdown editor, the save refusal, Site health); template developers (the `html` tag, picking markdown or richtext, moving HTML fields to rich text).
- **Absence as state:** nothing new shows unless script is found; a Markdown field looks like the rich-text field.
- **Same for every role:** the sanitizer and the save check don't depend on role (Q1).
- **Failure states:** the save refusal names the field and what to remove, in the existing validation banner; existing cases show in Site health with a link to the field (Q3).

### State tables

Per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md), each UI cut transcribes its table into stories.

Decided: maintainer, 2026-10-30 (#1579)

#### Save check (cut 2): validator `script-in-text`

Uses the existing validation banner and Site health drawer; no new component.

| State | What shows | `data-testid` |
|---|---|---|
| Save refused | Banner: "Script isn't allowed in Title: remove onerror." (the field's label, and what would be removed: a tag such as `<script>` or an attribute such as `onerror`) | existing `validation-banner`, `validation-issue-script-in-text` |
| Several fields | One issue per field | as above |
| Unsafe address | Banner: "Script isn't allowed in Link: remove javascript:." | as above |
| Site health | "about: Title holds script (onerror). Remove it before the next save of this field." with a link to the field | existing `site-health-drawer` rows |
| Plain `a < b` or `<b>` | Saves; shown as text | — |

#### Markdown editor (cut 4)

| State | What shows | `data-testid` |
|---|---|---|
| Default | Formatted view with the rich-text toolbar (bold, italic, heading, list, link, quote, code) | `markdown-editor` |
| Toggle | Two buttons: "Formatted" · "Markdown", the active one pressed | `markdown-mode-formatted`, `markdown-mode-markdown` |
| Markdown view | A plain text box with the raw Markdown, saved as typed | `markdown-source` |
| In Markdown view | Note under the toggle: "Formatted view may reformat Markdown.", followed by any known differences cut 4's parity check finds (Q8) | `markdown-mode-note` |
| Empty | Placeholder "Start writing...", as the rich-text editor shows | — |
| Arabic active | The editor follows the admin's `dir`, in both views | — |
| Untouched field saved | The field's Markdown unchanged | — |

## Foundational checks

- **Multi-instance:** escaping and sanitizing are pure functions; the validator is stateless.
- **Scale:** sanitizing runs per Markdown or rich-text field at render and publish; cut 1 measures it on the 5K-page synthetic site, since DOMPurify server-side needs a DOM. The validator runs per changed field at save and per field in the background scan.
- **Locale:** every locale variant is rendered and validated like the default; the editor follows `dir`; the sanitizer keeps `dir` and `<bdi>`.
- **Themes:** none; the editor uses the admin tokens.
- **Auth + RBAC:** no new capability (Q1).
- **Audit:** none new; refused saves aren't written.
- **Review:** none; approval isn't relied on (Q1).
- **Hooks:** `beforeSave` hooks run after validation, as today.
- **Render:** sanitizing in `processContent`; `RENDER_FORMAT_VERSION` raised (Q3).
- **Validation:** one validator, `script-in-text`, at save-delta (error) and background (error, Site health).
- **Plugin:** none.
- **Cache:** the render-format change invalidates publish hashes once; render-for-analysis output follows.
- **Offline:** save-delta validation runs offline.
- **Collaboration:** none.

## Cut sequence

Security first: live sites stop publishing script from content before the editor work starts.

Decided: maintainer, 2026-10-30 (#1579)

| Rejected | Why |
|---|---|
| Editor first | Plain text fields keep publishing script, and the starter keeps teaching raw interpolation, for longer; the editor's page preview needs cut 1 anyway |

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Sanitizer in `processContent` for Markdown and rich-text fields, nested fields included, removing forms and embeds too (Q2); draft content in the admin preview goes through the same conversion and sanitizer (`preview.ts` applies draft overrides after `processContent` today); the exported `html` tag (inserting children the renderer marks and its own results as is, arrays included) and `raw()` helper; tolerant schema conversion, and a template whose schema still can't be read fails to render; `RENDER_FORMAT_VERSION` raised; cost measured at 5K pages | — | unit + api | Medium |
| 2 | `script-in-text` validator at save-delta and background, walking nested values, unsafe address schemes and the file-field shape included, code fields as Site health info; a validator naming templates whose schema can't be read; banner and Site health wording per the state table | 1 | api + component | Low |
| 3 | Starter templates to `` html`` `` or rich text; gazetta.studio's `text` template to rich text; the ten composite templates interpolate rendered children inside `` html`` ``; the starter `showcase` escapes its `format.code()` snippet; `docs/templates.md` teaches `` html`` ``, `raw()`, children and markdown vs richtext | 1 | unit + docs | Low |
| 4 | Markdown editor: Tiptap with `@tiptap/markdown`, the toggle, untouched fields never rewritten; the page preview shows the field as published (sanitized by cut 1); round-trip, keyboard, screen-reader and RTL checks first, and a parity check of `@tiptap/markdown` against `marked` on the constructs the starter blog uses | 1, 2, 3 | component + e2e | Medium-high |
| 5 | Docs for authors and operators: the content-trust rule and the Markdown editor | 2, 3, 4 | docs | Low |

## Migration

No production users. Cut 1 marks every page changed; publish everything once after it (the CLI, or every item in the panel), since a publish of only some items leaves the rest's old, unsanitized HTML live.

Decided: maintainer, 2026-10-30 (#1579) Templates that interpolate plain text raw keep working but aren't protected until they use `` html`` ``; the save check covers content meanwhile, except code fields, which it skips: the starter `showcase` inserts its code snippet raw until cut 3.

## Open questions

1. **The admin and the site on one origin.** `gazetta dev` serves both on one origin, so script in a template, or in content saved before cut 2, runs next to the admin's cookies when someone opens the site URL. Whether production setups may do this, or the docs require a separate origin as for SVG, is undecided.

## Future directions

- **A `.md` import command**, when the first operator migrating from Hugo, Astro or WordPress asks (Q5).
- **Pages written as `.md` files**, when operators ask to keep pages as Markdown files in git, as file-based CMSes (Decap, Tina, Keystatic) do (Q5).
- **A raw HTML field (`format.html()`)**, when a site needs markup outside Tiptap's set (Q4).
- **Tracking images written inside Markdown**, with per-edge `asset-refs` edges (`design-media.md`).
