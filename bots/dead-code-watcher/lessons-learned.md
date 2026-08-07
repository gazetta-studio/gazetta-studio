# dead-code-watcher — lessons learned

Cross-finding memory Agent A reads at the start of every
investigation. Rewritten monthly by [`compact.ts`](compact.ts) from
the reviewer-log — only recurring actionable patterns land here.
Git history preserves dropped lessons.

---

## 1. Un-export beats delete when the symbol has internal use

Knip flags an exported symbol; grep shows no external consumers,
but the declaration IS still referenced inside its own file. Drop
`export` and keep the declaration.

**Signal:** 13 first-attempt approves across 6 runs, by shape:

- Internal type reference (6): `HreflangAlternate`,
  `SvgSanitizeWarning`, `ProviderCallInput`, `BuildHistory`,
  `HeartbeatFn`, `StorageEstimateFn` — flagged type is a field or
  parameter of another same-file `interface`/`type`.
- Default parameter fallback (3): `ANTHROPIC_DEFAULT_MODEL`,
  `OPENAI_DEFAULT_MODEL`, `defaultComponentIdGenerator` —
  `function foo(param = X)`.
- Formula/expression use (2): `CHARS_PER_TOKEN`, `MIN_MAX_TOKENS`
  — same-file arithmetic.
- Sister-function dispatch (1): `resolveEmbeddedRef` —
  `switch (kind)` calls it in the same file.
- Internal helper class (1): `AssetApiError` — thrown and
  duck-typed, not caught via `instanceof`.

**Guidance:** grep the declaring file for internal uses before
proposing deletion. The diff is one word; the commit message names
both what dropped AND why the declaration survives. Cite recent
identical precedents by SHA — reviewers credit it.

## 2. Verify BOTH public-surface paths before proposing removal

**Signal:** cited in every approval across the current log window.

**Guidance:** a symbol is public if EITHER (1) its file's subpath
appears in `packages/gazetta/package.json`'s `exports` field
(`./schema`, `./format`, `./admin-api`, `./providers/*`,
`./workers/*`, etc.), OR (2) it's re-exported from
`packages/gazetta/src/index.ts` — how most operator-facing factories
reach consumers even when the source file has no subpath.

Neither → removal safe. Either → file a `public-api` skip-list
entry documenting the exposure; do NOT propose the change.
`apps/admin` is a private Vue SPA workspace with no `exports` map,
so only path 2 applies there.

## 3. Barrel re-exports are dead when consumers import canonically

A file re-exports a symbol from a sibling module; all in-repo
consumers import directly from the sibling. The re-export line is
dead; the symbol itself is fine.

**Signal:** 6 approvals — `SharpAdapterOptions`,
`CloudflareAdapterOptions` (bypassed via `transforms/factories.ts`);
`AIAdapterFailedError`, `AIAdapterUnavailableError` (via
`ai/errors.js`); `eventFromRegistration` (via
`hooks/audit-emitter.js`); `BuildHookContextOptions` (inferred from
`buildHookContext`'s signature).

**Guidance:** when Knip flags a re-export line (not a definition),
trace where consumers actually import from. If all bypass the
barrel, drop only the barrel line — confirm the canonical export
still exists so the symbol isn't stranded. Symmetric-group risk:
if the same line re-exports paired symbols
(`sharpAdapter, cloudflareAdapter`) and Knip flagged only one,
escalate rather than break the pair.

## 4. Discriminate grep noise from real consumers

Grep for the flagged symbol returns matches beyond the declaration,
but they're either method-call sites on unrelated objects
(`api.getAsset` vs standalone `getAsset`) or substring hits inside
longer identifiers (`PublishRequest` inside `beforePublishRequest`).
The symbol is dead; the grep noise isn't a real consumer.

**Signal:** 2 first-attempt approves — `getAsset` (collision with
`api.getAsset` method) and `PublishRequest` (substring hits inside
`beforePublishRequest` / `afterPublishRequest` hook-phase name
literals).

**Guidance:** rule out three false-positive shapes before believing
grep says "still consumed":

- Object-property or method-call sites (`\.foo` vs standalone `foo`)
  — unrelated unless the lookup resolves back to the flagged export.
- Substring hits in longer identifiers — narrow to word-boundary
  matches (e.g. `\bSymbol\b`).
- Text-only mentions in JSDoc, test fixtures, or dead-code-watcher's
  own transcripts.

Name the ruled-out sources in the commit message — reviewers verify
and credit the honesty.
