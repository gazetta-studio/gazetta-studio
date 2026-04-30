---
paths:
  - "packages/gazetta/src/cli/**"
  - "packages/gazetta/src/providers/**"
  - "packages/gazetta/src/targets.ts"
  - "packages/gazetta/src/publish-rendered.ts"
  - "packages/gazetta/src/admin-api/routes/publish.ts"
  - "sites/*/site.yaml"
---

# Configurations

How Gazetta is developed, configured, and deployed. For CLI details see cli.md, hosting see hosting.md, custom editors see custom-editors.md, operations and edge cases see operations.md.

## What Gazetta Is and Is Not

| Gazetta IS | Gazetta is NOT |
|------------|----------------|
| Stateless CMS — all state in storage targets | A database-backed CMS (no database) |
| Composable — sites built from reusable components | A monolithic page builder |
| Framework-agnostic templates (React, Svelte, Vue, plain TS) | A React framework |
| Edge-first — Hono runtime on Workers/Deno/Node | A static site generator only (has SSR + ESI too) |
| Disposable — lose the CMS, reconnect to targets | A single point of failure |

**Not currently supported:** real-time collaboration, content versioning/drafts,
asset management (image upload/crop), visual drag-and-drop page builder, content
import from other CMS, webhook notifications on publish, offline editing.

## Development Modes

| Mode | Who | What they run | What they edit |
|------|-----|---------------|----------------|
| **Gazetta contributor** | Core developer | `npm run dev` from monorepo root (builds core, starts starter) | `packages/gazetta/`, `apps/admin/` |
| **Site author (new)** | End user | `npx gazetta init my-site && cd my-site && gazetta dev` | `templates/`, `sites/*/fragments/`, `sites/*/pages/`, `sites/*/site.yaml` |
| **Site author (existing)** | End user | `gazetta dev` in project dir | Same as above |
| **Template developer** | Frontend dev | `gazetta dev` — builds/tests templates in a site context | `templates/` (schema, render fn) + `admin/editors/` (custom editors) |
| **Admin UI developer** | Core developer | `npm run dev` from `apps/admin/` (Vite UI :3000 + Hono API :4000) | `apps/admin/src/client/`, `apps/admin/src/server/` |

The monorepo `npm run dev` starts `examples/starter` which has both filesystem and Azure Blob
targets configured — exercises most code paths locally.

## Site Topology

| Setup | Structure | site.yaml targets | Use case |
|-------|-----------|-------------------|----------|
| **Single site** | `sites/main/` (default from `gazetta init`) | 1+ targets | Most sites |
| **Multi-site monorepo** | Multiple dirs under `sites/` sharing templates | Each site has own `site.yaml` | Agency, multi-brand |

Multi-site: each site is independent. CLI operates on one site at a time (`gazetta publish production my-site`).
Templates and admin are shared across all sites in the project.

## File Structures

### Gazetta monorepo (contributor / core developer)

```
gazetta/
  package.json                 # workspaces: ["packages/*", "apps/*", "examples/*", "sites/*"]
  packages/
    gazetta/                   # Core package — renderer, CLI, admin API, editor, storage providers
      src/
        cli/                   # CLI commands (dev, publish, build, deploy, serve, validate)
        admin-api/             # Hono API routes (pages, fragments, templates, preview, publish)
        editor/                # Default editor — @rjsf form, Tiptap, custom widgets
        types.ts               # EditorMount, FieldMount, TemplateModule, etc.
      package.json             # peerDependencies: { react, react-dom }
  tools/
    mcp-dev/                   # MCP dev server (screenshot tool)
  apps/
    admin/                  # CMS admin frontend — Vue 3 + PrimeVue shell
      src/client/              # Vue SPA (stores, components, composables, router)
      src/server/              # Dev server entry
      vite.config.ts
  examples/
    starter/                   # Example site (exercises most code paths)
  sites/
    gazetta.studio/            # Production site (dogfooding)
```

### Site project (site author / template developer)

Templates and admin are project-level (shared across sites). Content (fragments, pages) lives in `sites/`.

```
my-project/
  package.json                 # workspaces: ["admin", "templates"]
  admin/                       # Custom editors + fields (browser, CMS-aligned) — workspace
    package.json               # deps: { gazetta, react, react-dom, @radix-ui, ... }
    editors/                   # Custom editors (per-template full replacements)
      hero.tsx                 # EditorMount for templates/hero
    fields/                    # Custom fields (reusable widgets)
      brand-color.tsx          # FieldMount — referenced in schemas as { field: 'brand-color' }
  templates/                   # Template render functions + schemas (server) — workspace
    package.json               # deps: { gazetta, react, svelte, zod, ... }
    hero/index.tsx             # template name: "hero"
    card/index.ts              # template name: "card"
    page-default/index.tsx     # template name: "page-default"
    nav/index.svelte           # non-React template
    buttons/                   # optional subfolders for design systems
      primary/index.tsx        # template name: "buttons/primary"
      cta/index.tsx            # template name: "buttons/cta"
  sites/
    my-site/                   # A site — content + config
      site.yaml                # Site manifest — name, targets
      fragments/               # Shared components (reusable across pages)
        header/
          fragment.json        # all components inline
        footer/
          fragment.json
      pages/                   # Routable components
        home/
          page.json            # all components inline
        about/
          page.json
    another-site/              # Another site — same templates, different content
      site.yaml
      fragments/
      pages/
```

**Modularity — what belongs to what:**

| Concept | Scope | Runs where | Deps aligned with | Lives in |
|---------|-------|-----------|-------------------|----------|
| Template (render + schema) | Project | Server (Node) | Shared (workspace) | `templates/` (flat, optional subfolders) |
| Editor (custom editing UI) | Project | Browser (admin) | Admin UI (same React) | `admin/editors/` |
| Field (custom widget) | Project | Browser (admin, inside @rjsf) | Admin UI (same React) | `admin/fields/` |
| Fragment (content) | Site | Server (rendered) | Templates | `sites/x/fragments/` |
| Page (content) | Site | Server (rendered) | Templates | `sites/x/pages/` |

Templates are flat by default. Subfolders are opt-in for grouping (e.g. `buttons/primary`, `cards/product`). A template doesn't inherently know its usage — the same template can serve as a page, fragment, or component template. The type is decided by the content (page.json, fragment.json), not by the template.

Templates, editors, and fields are shared across all sites in the project. Fragments and pages are per-site.

Editors are conceptually 1:1 with templates but dependency-coupled to the admin. `admin/editors/hero.tsx` is the editor for `templates/hero/` — connected by name, not file path.

**Type access:** Editors import **types only** from templates via `import type` (erased at runtime, no cross-workspace dependency). Templates export a content type: `export type HeroContent = z.infer<typeof schema>`. Editors import it: `import type { HeroContent } from '@templates/hero'`. The `@templates` alias is configured in `tsconfig.json` paths.

**Dependencies:**
- `admin/` and `templates/` are npm workspaces — **one `npm install`** at the project root. `sites/` are just directories (no code, no deps).
- By default, templates share the project's React version. Non-React templates (Svelte, Vue, plain TS) don't conflict.
- Edge case: if templates need a different React version, remove `templates` from workspaces and run `cd templates && npm install` separately (or use pnpm which handles version isolation natively).

**Install:**
```
cd my-project && npm install    # everything — admin + templates workspaces
```

## Storage Providers

| Provider | Type in site.yaml | Auth (local) | Auth (CI) | Init |
|----------|-------------------|-------------|-----------|------|
| **Filesystem** | `filesystem` | None (file access) | None | Auto-creates dirs |
| **Cloudflare R2** | `r2` | `accessKeyId`+`secretAccessKey` (R2 API token) | Same, via env vars | Creates bucket if needed |
| **AWS S3 / MinIO** | `s3` | `accessKeyId`+`secretAccessKey` | Same, via env vars | Creates bucket if needed |
| **Azure Blob** | `azure-blob` | `connectionString` (supports Azurite `UseDevelopmentStorage=true`) | `connectionString` via env var | Creates container if needed |

All providers implement `StorageProvider` interface: `readFile`, `readDir`, `exists`, `writeFile`, `mkdir`, `rm`, `readStream`, `writeStream`.

Credentials use `${ENV_VAR}` syntax in site.yaml, resolved at runtime. CLI loads `.env` from
site dir (skipped when `CI=true`).

R2 uses the S3-compatible API. Create an R2 API token at the Cloudflare dashboard
(R2 → Manage R2 API Tokens) — same credentials work locally and in CI.

## Target Configurations

A target = storage + optional worker + optional cache + optional publishMode.

| Target type | Worker config | Publish mode | Serve mode | Fragment updates |
|-------------|--------------|--------------|------------|-----------------|
| **Edge (Cloudflare)** | `worker: { type: cloudflare }` | ESI — pages have `<!--esi:-->` placeholders, fragments stored separately | Cloudflare Worker assembles at edge | Instant — republish fragment only |
| **Self-hosted server** | `publishMode: esi` (no worker needed) | ESI — same as edge | Node/Bun Hono server via `gazetta serve` | Instant — republish fragment only |
| **Static hosting** | No worker, no server | Static — pages fully assembled, fragments baked in | GitHub Pages / Netlify / S3 / any file server | Requires republishing all pages using that fragment |

Decision logic: determined by `publishMode` field in target config (default: `static` if no worker, `esi` if worker configured).

Both CLI and admin API use `getPublishMode(target)` from `types.ts` to determine mode.
`gazetta serve` also reads `publishMode` to decide whether to do ESI assembly or serve static files.

### Real-world target examples

```yaml
# Local dev — filesystem, static mode
staging:
  storage: { type: filesystem, path: ./dist/staging }

# Cloudflare — R2 + Worker, ESI mode
production:
  storage: { type: r2, accountId: "...", bucket: "my-site", accessKeyId: "${R2_ACCESS_KEY_ID}", secretAccessKey: "${R2_SECRET_ACCESS_KEY}" }
  worker: { type: cloudflare, name: my-site }
  siteUrl: "https://mysite.com"
  cache: { browser: 0, edge: 86400, purge: { type: cloudflare, apiToken: "${CLOUDFLARE_API_TOKEN}" } }

# Azure Blob — local dev with Azurite emulator
production:
  storage: { type: azure-blob, connectionString: "UseDevelopmentStorage=true", container: "my-site" }

# Self-hosted — S3 storage, served by gazetta serve
production:
  storage: { type: s3, endpoint: "https://s3.amazonaws.com", bucket: "my-site", region: "us-east-1", accessKeyId: "${AWS_ACCESS_KEY_ID}", secretAccessKey: "${AWS_SECRET_ACCESS_KEY}" }
  publishMode: esi  # ESI for gazetta serve — no worker needed
```

### Invalid/misleading combinations

| Combination | What happens | Problem |
|-------------|-------------|---------|
| R2 + no worker | Publishes static HTML to R2 | Can't serve — no worker at edge, `gazetta serve` from cloud R2 is inefficient |
| Filesystem + worker config | Publishes ESI mode, `gazetta serve` works | Worker name is dead config — `gazetta deploy` would try to deploy to Cloudflare from local files |
| `cache.purge` on non-Cloudflare target | Purge silently skipped | User thinks cache is purged, but it's not. Only `purge.type: cloudflare` is implemented |
| `worker.type` other than `cloudflare` | `gazetta deploy` fails with error | `WorkerConfig.type` is `string` but only `'cloudflare'` is handled. Should be a literal type |

## site.yaml Complete Schema

```yaml
name: My Site                              # required — display name
locale: en                                 # optional — default locale (default: en)
baseUrl: https://mysite.com                # optional — production URL for SEO/meta
systemPages: [404]                         # optional — system page names

admin:                                     # optional — admin UI configuration
  auth: basic                              # auth method (basic | none)
  users:                                   # users for basic auth
    - username: admin
      password: "${ADMIN_PASSWORD}"

targets:                                   # required — at least one target
  staging:
    storage: { type: filesystem, path: ./dist/staging }
  production:
    storage: { type: r2, ... }
    worker: { type: cloudflare, name: my-site }
    publishMode: esi                       # optional — esi | static (auto-detected from worker)
    environment: production                # optional — local | staging | production. Default: local for filesystem, production otherwise. Drives admin UI confirmation prompts and badges.
    siteUrl: https://mysite.com            # optional — for cache purge URL resolution
    cache:                                 # optional — caching configuration
      browser: 0                           # browser cache TTL in seconds
      edge: 86400                          # CDN cache TTL in seconds
      purge:                               # CDN cache purge
        type: cloudflare
        apiToken: "${CLOUDFLARE_API_TOKEN}"
    history:                               # optional — per-target undo / rollback (default: enabled, retain 50)
      enabled: true                        # set to false to skip .gazetta/history/ writes entirely
      retention: 50                        # keep at most N most-recent revisions; oldest evicted
```

Custom site-level settings can be added as top-level fields — accessible to templates via
the render context. Not currently validated — future schema for site.yaml.

## Data Flow Summary

```
                    ┌──────────────┐
                    │  Developer   │
                    │  (templates) │
                    └──────┬───────┘
                           │ creates
                    ┌──────▼───────┐
  gazetta init ──►  │   Project    │  ◄── content author (admin UI)
                    │  templates/  │
                    │  admin/      │
                    │  sites/      │
                    └──────┬───────┘
                           │
         ┌─────────────────┼──────────────────┐
         │                 │                  │
  gazetta dev       gazetta publish    gazetta build
  (on-the-fly)      (render + push)    (admin + worker)
         │                 │                  │
         │          ┌──────▼──────┐    gazetta deploy
         │          │  Renderer   │    (worker to edge)
         │          │ (SSR + ESI) │           │
         │          └──────┬──────┘           │
         │                 │                  │
         │          ┌──────▼──────────────────▼──┐
         │          │          Targets            │
         │          │  ┌─────────┐ ┌───────────┐ │
         │          │  │ Storage │ │Worker/Srvr│ │
         │          │  └─────────┘ └───────────┘ │
         │          └────────────────────────────┘
         │                       │
         │                ┌──────▼──────┐
         └──────────────► │   Browser   │
                          └─────────────┘
```

## Known Gaps

Summary of configuration gaps and inconsistencies. Reference this when working on publish,
targets, or CLI commands to avoid re-introducing these issues or building on broken assumptions.

| # | Gap | Severity | Location | Status |
|---|-----|----------|----------|--------|
| ~~1~~ | ~~Admin API always publishes ESI, ignores static mode~~ | ~~Critical~~ | | Fixed — uses `getPublishMode()` |
| ~~2~~ | ~~Publish mode coupled to worker config~~ | ~~High~~ | | Fixed — `publishMode` field on `TargetConfig` |
| 3 | Cache purge only implements Cloudflare | Medium | `cli/index.ts`, `admin-api/routes/publish.ts` | Silent no-op for S3/Azure purge configs |
| ~~4~~ | ~~`WorkerConfig.type` is `string`~~ | ~~Low~~ | | Fixed — literal type `'cloudflare'` |
| 5 | `validate` doesn't check targets | Medium | `cli/index.ts` | No storage connectivity, env var, or credential checks |
| 6 | `fetch` can't recover from static targets | Medium | `admin-api/routes/publish.ts` | Static targets have rendered HTML, not source manifests |
| 7 | No validation of nonsensical target combos | Low | `targets.ts` | R2+no worker, filesystem+worker silently accepted |
