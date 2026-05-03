# "Component" is not a domain noun

`design-concepts.md` historically presented Component as the abstract base of a hierarchy ("Component is the base. Fragment and Page are specialized kinds."). The codebase reflects this with `ComponentManifest` as a shared base type. We dropped Component as a domain noun: in conversation and docs, always say Page, Fragment, or Inline Component explicitly; never the abstract base.

## Why this is surprising

The `ComponentManifest` TypeScript type still exists. A future reader scanning code will reasonably ask "isn't 'Component' the domain word for the base?" and start using it in PRs and docs. The answer is no — the type name is internal terminology preserved for code stability, not a domain concept.

## Why we made this call

"Component" collides with React/Vue components, which Gazetta templates frequently ARE. A Template Developer reading "Gazetta component" has to translate every time. design-concepts.md, design-publishing.md, and design-editor-ux.md never actually need the abstract base in conversation — they always name the concrete things (Page, Fragment) instead. The hierarchy lived in the type system, not the language.

## Consequences

- When you need "any of {Page, Fragment, Inline Component}," name them explicitly.
- `ComponentManifest`, `ComponentEntry`, `InlineComponent` are internal type names; they're not domain language.
- Docs and PR descriptions should use the specific noun (Page Manifest, Fragment Manifest) rather than "the component manifest."
- The Children of a Page or Fragment are Fragment References + Inline Components, never just "components."
