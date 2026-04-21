# Media (Assets) — Reference

Companion to [design-media.md](design-media.md). Fact-checked tooling specifics, licensing details, and codebase-alignment notes. Consulted during implementation rather than read linearly.

See [design-media.md](design-media.md) for the design and [design-media-implementation.md](design-media-implementation.md) for phases and scope.

## Library and tooling specifics

- **sharp** — Apache-2.0, current v0.34.5. `.rotate()` with no args auto-applies EXIF orientation (equivalent to calling `.autoOrient()`, which became a separate method in v0.34.0). Default output strips **all** metadata including ICC profile; must opt into `keepIccProfile()` explicitly. Prebuilt binary does **not** include HEIC support — requires a system-level libvips built with libheif. Treat HEIC as a deployment-dependent capability; reject HEIC uploads with a clear error when unavailable.
- **@rjsf/core** — codebase pins to `^6.4.0`. Current npm latest is 6.5.1 (v6 line is stable). Don't upgrade the major silently.
- **Zod version** — codebase uses Zod v4 (`^4.3.6`). v4 has breaking changes from v3: unified `error` param, stricter number validation, top-level string-format methods (`z.email()`, `z.uuid()`), defaults apply inside optional fields, `z.function()` no longer returns a schema, simplified `ZodType` generics. `z.infer<typeof schema>` still works the same. Schema helpers should be written against v4.
- **Zod → JSON Schema conversion** — Zod v4 ships a native `z.toJSONSchema()` method. Prefer it over the external `zod-to-json-schema` package (which is still published at 3.25.2 but now legacy for v4 users). The codebase has neither imported today; the v4 native method is the right starting point for schema-helper work.
- **DOMPurify** — v3.4.1 (MPL-2.0 OR Apache-2.0), covers HTML/SVG/MathML. `USE_PROFILES: { svg: true }` is the documented config for SVG sanitization. `isomorphic-dompurify` (MIT, v3.9.0) is the SSR-friendly wrapper that works identically on server and client.
- **`file-type`** — v22+ is the maintained version for MIME sniffing. Handles WOFF2/WOFF/TTF/OTF for font detection via magic bytes. Verify stream-based sniffing supports Node `ReadableStream` vs Web `ReadableStream` for the storage provider's streaming upload path.
- **`music-metadata`** — MIT, v11+. Handles MP3/WAV/FLAC/OGG/M4A/Opus/MP4 metadata extraction including duration. Use for audio upload duration extraction. Also covers MP4/M4A so it's a single dep for both audio and some video duration needs. Do **not** use `mp4-duration` — that package name doesn't exist on npm; `mp4duration` (no hyphen) is a 2019-stale toy.
- **Unicode `unicode-range`** — CSS Fonts Module 4 feature, ~85% global browser support (caniuse/BCD). Stable and Baseline. Google Fonts serves multi-script families (Noto Sans JP, etc.) as dozens of `@font-face` chunks each with narrow `unicode-range` — this is the industry-standard pattern Gazetta's font resolver emits.

## Transform engine licensing

v1 uses **sharp** (Apache-2.0) as the bundled transform engine. License stack is clean: sharp is permissive, its underlying libvips is LGPL-2.1 dynamic-linked, no copyleft propagation to consumers of the sharp npm package. Same pattern as Next.js, Astro, Payload, Strapi.

A future **TransformEngine adapter interface** could support alternates (imgproxy, Cloudflare Images, Cloudinary). If an imgproxy adapter ships, relevant terms:

- imgproxy is MIT; imgproxy OSS is fully functional, imgproxy Pro (paid, closed) adds features we don't need
- libvips (LGPL-2.1) and libheif (LGPL-3) are dynamic-linked underneath imgproxy — same pattern as sharp
- No AGPL anywhere in the chain
- **Prefer npm-post-install-download** (sharp-style) over bundling imgproxy in a Docker image — distribution obligations for LGPL libs stay upstream with imgproxy, not with Gazetta
- If Docker bundling is ever needed, include: imgproxy MIT notice, libvips LGPL-2.1 + license text + source availability, libheif LGPL-3 + license text + source availability, `THIRD_PARTY_NOTICES` file

Minor future-risk signal: imgproxy has a Pro business model, so upstream has commercial incentive. Any released version stays MIT forever (a fork is always possible), but a future major could theoretically relicense. MinIO made that move in early 2026 but started from AGPLv3, which is a weaker precedent than MIT.

## HTTP and caching specifics

- **`Cache-Control: immutable`** — RFC 8246 (2017, Patrick McManus). Firefox 49+ and Safari 11+ implement it. Chrome **does not** implement it (caniuse/BCD shows Chrome `version_added: false`, linking Chromium bug 41253661 as not-implemented). Fine for our use — the URL itself changes on byte change, so even without `immutable` a Chrome revalidation is a cheap 304 on the old URL.
- **`Content-Disposition`** — RFC 6266 (2011) specifies the header for HTTP; the percent-encoded `filename*=UTF-8''…` syntax is defined by **RFC 8187** (2017, which obsoleted RFC 5987). RFC 6266 still references 5987 in its text, but implementers should follow 8187. For filenames with special chars, include both `filename` (ASCII fallback) and `filename*=UTF-8''<percent-encoded>`. Browsers prefer `filename*` when both are present.
- **`ETag`** values must be double-quoted per HTTP spec.
- **`X-Content-Type-Options: nosniff`** — blocks mismatched script/style MIME; disables sniffing elsewhere (MDN).
- **`<video>` / `<audio>` and `Content-Disposition: attachment`** — no WHATWG HTML spec guidance; UA-discretionary. Browsers vary on whether they honor attachment disposition for recognized media types. Test before relying on it for forced downloads of media.

## Provider-specific limits

- **Cloudflare Workers body limit:** Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise 500 MB. Not a simple "free vs paid" split.
- **Cloudflare Workers CPU time (HTTP requests):** Free 10 ms, Paid default 30 s up to 5 min max. The "15 min" figure applies only to long-interval cron triggers, not HTTP.
- **Cloudflare Workers request billing** — cache hits still bill (the Worker runs before cache consults).
- **Cloudflare Workers Static Assets default `Cache-Control`:** `public, max-age=0, must-revalidate` unless overridden.
- **R2 object size:** single PUT up to ~4.995 GiB (5 GiB minus 5 MiB); multipart up to ~4.995 TiB with max 10,000 parts.
- **R2 range requests:** single-byte-range supported via 206; multi-range not supported.
- **R2 `Content-Disposition`:** settable via `httpMetadata.contentDisposition` on the object, returned via `writeHttpMetadata()` when objects are served.
- **S3 single PUT:** 5 GB; multipart up to 50 TB; console up to 160 GB.
- **Azure Blob:** block blob max ~190.7 TiB (4000 MiB × 50,000 blocks, service version 2019-12-12+). Single `Put Blob` write limit 5000 MiB.
- **Filesystem filename limits:** ext4 and APFS 255 bytes; NTFS 255 UTF-16 code units. Our 200-char-per-segment cap leaves headroom on all three.

## Security specifics

- **SVG sanitization is mandatory.** Attack surfaces: `<script>`, event handlers (`onclick`, `onload`, etc.), `xlink:href` and `href` to external resources on `<use>` / `<image>` / `<script>`, `<foreignObject>` embedding HTML. `xlink:href` is deprecated in SVG 2 in favor of `href`; both must be sanitized.
- **RFC 1918 private IP ranges:** 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16. Block for SSRF protection. OWASP guidance is that deny-lists are last-resort; allow-lists of known-good providers are stronger and recommended for the future proxy feature.
- **Homoglyph attacks are not defeated by NFC normalization.** Cyrillic 'а' and Latin 'a' are canonically distinct codepoints. Proper defense requires UTS #39 (Unicode Security Mechanisms) — mixed-script detection and confusable detection. Our slugify-to-ASCII default sidesteps this entirely.

## Codebase alignment verified

- **`TargetConfig.siteUrl`** — already exists; the resolver reuses it as the URL base rather than introducing a `publicUrl` field.
- **History system** — substantially implemented. `Revision` / `RevisionManifest` types (`packages/gazetta/src/history.ts`) with `snapshot: Record<string, string>` mapping content paths to blob hashes; content-addressed **SHA-256** blobs at `.gazetta/history/objects/<hh>/<rest>` (via `createHash('sha256')` in `history-provider.ts`); retention default 50 via `DEFAULT_HISTORY_RETENTION` (`types.ts:233`); recorder called from save (pages.ts, fragments.ts) and publish routes via `recordWrite()`; restorer implemented; `/api/history` route exists.
- **Two hash algorithms coexist** — history uses **SHA-256**. The existing publish-rendered pipeline (`publish-rendered.ts`) uses **MD5** (first 8 hex chars) for the `.{8hex}.hash` sidecar filenames that power compare-targets. The design doc's "8-char sha256 prefix" for asset URLs introduces a third hash usage — worth standardizing on SHA-256 for new asset work rather than extending the MD5 sidecar pattern, since MD5 is legacy and SHA-256 is already in the history stack.
- **Sidecar pattern** — `SourceSidecarWriter` at `packages/gazetta/src/source-sidecars.ts` memoizes backfill via `backfillPromise` (Promise-level in-flight sharing, not result-cached). Three sidecar kinds documented in `sidecars.ts`: `.{8hex}.hash` for content hashes (used by compare-targets), `.uses-<name>` for fragment references, `.tpl-<name>` for template references. Asset refs would be a fourth kind if we used the same pattern; this design instead uses JSON-per-asset index files in `.refs/` because refs aggregate (one file per asset listing all usages) rather than fan out (one file per dependency edge).
- **Save vs publish pipelines.** Save writes manifests directly via `storage.writeFile()` (no render). Publish renders + assembles + writes via `publishItems()` + `publishPageRendered()`. Both call `recordWrite()` into history. The media work extends publish, not save.
- **Schema helpers don't exist yet.** No `packages/gazetta/src/schema.ts`, no `gazetta/schema` export. `embeddedAsset()` / `downloadable()` / `fontAsset()` are new surface to add.
- **Storage providers confirmed:** filesystem, R2, S3, Azure Blob — four providers at `packages/gazetta/src/providers/*.ts`, all implementing the current text-only `StorageProvider` interface. Nothing else in the directory.
- **Hono v4** (`^4.12.0`) + **Zod v4** (`^4.3.6`) + **PrimeVue v4** (`^4.5.0`) + **Vue 3.5** + **Vite v8** (admin uses `^8.0.8`). All current majors as of 2026-04.
- **TypeScript strict mode confirmed** in `packages/gazetta/tsconfig.json` (`"strict": true`).
- **SEO usage of `siteUrl`** — used as the base URL for canonical tags, sitemap, and robots generation. Reusing it for asset URLs is a light additional load; add a dedicated `assetsUrl` override per target if/when CDN split is needed (not v1).

## Unverified — check before citing as fact

- **Sanity's asset hash algorithm** (SHA-1 vs SHA-256) — asserted as SHA-1 in earlier research but not confirmed from Sanity's public docs. Don't cite as a fact when making comparison claims.
- **PrimeVue DataView keyboard navigation** — does not provide full keyboard navigation out of the box; only the layout toggle buttons are keyboard-responsive. Grid keyboard nav will be custom work.
- **Strapi bug references** — issue #4384 ("Deleting file from 'Files Upload' breaks any other content that has reference as a 'Media' relation to that file"; created 2019-10-28, **CLOSED**, 7 comments) is the canonical historical example of delete-leaves-broken-refs. Cite #4384 as a historical reference for this bug class; do not cite #11939 (different bug). Closure status does not mean the bug class is fully resolved in Strapi — it's the public-record example of the pattern we're avoiding.
- **Hono version** — codebase uses Hono v4 (`^4.12.0`); Hono current major is v4. All admin-api routes import `Hono` from `hono`.
- **PrimeVue version** — admin uses PrimeVue v4 (`^4.5.0`). Keyboard navigation limitation noted above applies to v4's DataView.
