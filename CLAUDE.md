# Gazetta

Stateless CMS that structures websites as composable fragments. All state lives in targets.

## Structure

- `apps/admin/` — CMS admin frontend (Vue 3 + PrimeVue editor shell)
- `packages/gazetta/` — Core package (renderer, CLI, admin API, editor, storage providers)
- `tools/mcp-dev/` — MCP dev server (screenshot tool)
- `examples/starter/` — Sample site with templates, fragments, pages
- `sites/gazetta.studio/` — The gazetta.studio website (dogfooding)
- `docs/design.md` — Human-readable design document
- `docs/cloudflare.md` — Cloudflare deployment guide (R2, Workers, cache, CI)
- `docs/self-hosted.md` — Self-hosted deployment guide (VPS, Docker, Fly.io)
- `docs/sidecars.md` — Sidecar files (incremental publish, reverse-dep lookups)
- `docs/feature-gaps.md` — CMS feature gap analysis (media, i18n, drafts, SEO, RBAC, etc.) — read when planning new features or discussing roadmap
- `docs/template-assets.md` — Template developer guide for asset references (schema helpers, resolved shapes, rendering)
- `docs/content-assets.md` — Author guide for the asset library (upload, replace, locale overrides, focal point, alt)
- `docs/migration.md` — Migrating templates from `z.string()` URLs to `embeddedAsset()` references
- `docs/transform-adapters.md` — Per-target image delivery strategies (sharp default, cloudflare CDN, future adapters)

## Design docs (auto-loaded by Claude)

- `.claude/rules/design-concepts.md` — Fragment, page, node, target model; target properties; active target
- `.claude/rules/design-publishing.md` — Stateless CMS, bidirectional sync, targets, unified Publish
- `.claude/rules/design-decisions.md` — Key decisions and rationale
- `.claude/rules/design-editor-ux.md` — Active target UX spine, switching, progressive disclosure
- `.claude/rules/design-media.md` — Asset model, storage, refs, resolver, delete-with-replace, admin UX, i18n, distinctive choices
- `.claude/rules/design-media-reference.md` — Fact-checked tooling specifics, library versions, licensing, codebase-alignment notes
- `.claude/rules/design-media-implementation.md` — v1 scope + estimates, phased alt, out-of-v1, v1.5/v2 capabilities, frontier opportunities, open questions, migration
- `.claude/rules/architecture.md` — System architecture and package layout
- `.claude/rules/testing-plan.md` — Active testing coverage + e2e restructure plan (auto-loads when editing tests)

## Build & Test

```bash
npm install        # install dependencies (from root)
npm run build      # build all packages
npm run dev        # start dev server (examples/starter on localhost:3000)
npm test           # run all tests
```

**Note:** Page and fragment manifests use JSON (`page.json`, `fragment.json`). Site config stays YAML (`site.yaml`). Components are inline in the page manifest — no separate component files.

## Conventions

- TypeScript strict mode everywhere
- Prefer composition over inheritance
- Extract shared code only when 3+ callers exist
