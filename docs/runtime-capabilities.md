# Runtime capabilities

Some Gazetta features need runtime help from the target — for example, **soft-delete** needs a worker to read the archived-page HTML marker and emit `301` redirects. Plain-static deployments (Cloudflare Pages without a worker, GitHub Pages, raw S3) can't do that on their own.

This page documents the per-target capability matrix and the host-glue mechanisms that close gaps where they exist.

## Capabilities

| Capability      | What it does                                                  | Used by      |
| --------------- | ------------------------------------------------------------- | ------------ |
| `redirects`     | Emit `301 → aliasOf` for archived items with an alias          | Soft-delete  |
| `gone-status`   | Emit `410 Gone` for archived items without an alias            | Soft-delete  |

The capability vocabulary is a closed enum that grows additively as new features need runtime help. Future capabilities (live presence connections, per-request RBAC content filtering, dynamic fragments) will extend the matrix.

## Per-target matrix

| Target type                                     | `redirects` | `gone-status` | Notes                                              |
| ----------------------------------------------- | ----------- | ------------- | -------------------------------------------------- |
| `static` + Cloudflare Worker                    | ✓           | ✓             | Worker reads HTML markers, emits 301/410           |
| `static` + `redirects.format: 'cloudflare'`     | ✓           | ✗             | Cloudflare Pages honors `_redirects` file          |
| `static` + `redirects.format: 'netlify'`        | ✓           | ✗             | Netlify honors `_redirects` file                   |
| `static` + `redirects.format: 'json'`           | ✓           | ✗             | Custom integrations consume `redirects.json`       |
| `static` (no worker, no redirects)              | ✗           | ✗             | Plain-static; falls back to host's natural 404, but `gazetta serve` answers 301/410 itself when it serves the target |
| `esi`                                           | ✓           | ✓             | Worker is required for ESI assembly                |
| `dynamic`                                       | ✓           | ✓             | Origin server emits 301/410 directly               |

Only a worker or an origin server sends `410 Gone`. Cloudflare Pages can't return 410 from `_redirects`, and Netlify doesn't document it, so the `cloudflare` and `netlify` files have no row for an archived page without an alias, and it answers 404. The `json` file still lists those pages under `gone`, for custom integrations that can send 410.

For plain-static targets, the **host's 404** is the floor: visitors hitting a missing URL get whatever the host shows for a missing file. Every publish to a static target writes `404.html` at the target root: a copy of the site's `/404` page in the default language as published to that target, or a minimal "Page not found" page (marked `noindex`) until the 404 page is published there. Cloudflare Pages, Netlify and GitHub Pages show it for missing paths; an S3 website shows it when its error document is set to `404.html`. `gazetta serve` on a static target answers missing paths with it too, with status 404. Google treats 404 and 410 alike and drops the URL either way ([HTTP status codes](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes)).

## Public storage

A target whose storage visitors can reach directly (`publicStorage`, public by default unless the target is an editing folder or a copy adapter deploys it) keeps none of Gazetta's sensitive state. On a public target:

| Feature | Available? | Why |
| ------------------------- | ---------- | ------------------------------------------------------- |
| History, undo, rollback   | ✗          | Past versions would be downloadable                     |
| Audit log on the target   | ✗          | Recorded on a private target instead, or not at all     |
| Content review            | ✗          | Review state names approvers                            |
| Scheduling (not built yet) | ✗          | Schedules are kept as state on the target               |
| Publish approval          | ✓          | Requests are kept on the source                         |

The admin's "About this target" view (target menu) and `npx gazetta targets` show this per target. Details: [Where Gazetta keeps its own files, and when they're public](audit.md#where-gazetta-keeps-its-own-files-and-when-theyre-public).

## How gaps surface

When a target lacks a capability that an in-flight feature needs, Gazetta surfaces the gap at four uniform points so authors and operators see it before it bites:

1. **Boot config validate** — once the site has archived pages, the admin server warns when a target's runtime can't serve required capabilities (e.g., archive operations on a plain-static target): at boot in `gazetta dev`, on the first request that loads the site in `gazetta admin`. A site with nothing archived gets no warning.
2. **Author-time modal** — feature-specific modals (the archive modal, future scheduling modals) show per-target capability badges with the gap reasons inline.
3. **Background scanner** — the validation framework's site-health drawer surfaces capability-gap warnings (e.g., `archive-not-supported-on-target`) so operators see issues that have already accumulated.
4. **Pre-publish gate** — the publish dialog's audit step lists per-target compatibility issues; the operator can promote to error or accept.

This four-point pattern is the **capability-gap UX** principle — see `feature-design-process.md` non-foundational disciplines. Every future feature needing runtime help inherits the same four surfaces.

## Host-glue: `_redirects` for static targets

For plain-static deployments on hosts that honor a `_redirects` file (Cloudflare Pages, Netlify), opt into the publish-time generation:

```ts
import { defineSite, r2Storage, filesystemStorage } from 'gazetta'

export default defineSite({
  targets: {
    'production-pages': {
      environment: 'production',
      storage: r2Storage({ /* ... */ }),
      type: 'static',
      siteUrl: 'https://example.com',
      redirects: { format: 'cloudflare' },   // 'cloudflare' | 'netlify' | 'json' | 'none'
    },

    'production-fly': {
      environment: 'production',
      storage: filesystemStorage({ path: './dist/fly' }),
      type: 'static',
      siteUrl: 'https://example.com',
      redirects: { format: 'json' },         // for custom integrations
    },
  },
})
```

The publish flow walks all archived manifests at the end of each publish and writes the host-glue file at the target root:

```text
target-root/
├── pages/
├── _redirects                 # cloudflare / netlify
└── redirects.json             # json
```

Wire format:

**`_redirects` (Cloudflare Pages, Netlify):**

```text
/old-page    /new-page    301
```

One row per archived page with an alias, per language the target publishes; an archived page without an alias gets none. Sorted alphabetically by source for determinism — the same input produces the same file, so host CDN caches hit when you republish unchanged.

Cloudflare Pages reads at most 2,000 static rows from `_redirects` ([Cloudflare docs](https://developers.cloudflare.com/pages/configuration/redirects/)). When a `cloudflare` target's file would have more, `gazetta publish` prints a warning after the `_redirects` line, and `gazetta validate` and the admin's pre-publish audit show it as a warning. A four-language target reaches the limit at 500 archived pages with an alias.

**`redirects.json` (custom integrations):**

```jsonc
{
  "redirects": [
    { "from": "/old-page", "to": "/new-page", "status": 301 }
  ],
  "gone": [
    { "path": "/retired", "status": 410 }
  ]
}
```

When `redirects.format` is `'none'` (or unset), no file is emitted. Worker-served targets ignore the field — they read the HTML markers directly.

## Closing the gap entirely

For deployments that can't honor `_redirects` (raw S3 static-website, basic CDN configurations), the gap is structural — there's no mechanism the host can run to emit 301/410. Two paths to close it:

1. **Add a worker** in front of the target. Cloudflare Workers, Deno Deploy, `gazetta serve` all work. Switch to `type: 'dynamic'` (or keep `type: 'static'` and add a `worker:` config block).
2. **Migrate to a host that honors `_redirects`** — Cloudflare Pages and Netlify both do, with no per-deployment config beyond the file existing at the site root.

The capability-gap UX makes the choice visible at config-validation time; you don't need to dig through documentation to discover the limitation.

## Reference

- **Implementation**: `packages/gazetta/src/runtime/runtime-capabilities.ts` — pure predicates over `TargetConfig`
- **Design rationale**: `feature-design-process.md` non-foundational disciplines; `design-soft-delete.md` Q10
- **Soft-delete docs**: [soft-delete.md](soft-delete.md) — the v1 consumer of these capabilities
- **Redirects reference**: `.claude/rules/design-redirects.md` — consolidated 301/410/_redirects model
