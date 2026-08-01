# dead-code-watcher — lessons learned

Cross-finding memory Agent A reads at the start of every
investigation. Rewritten monthly by
[`compact.ts`](compact.ts) from the reviewer-log — only recurring
actionable patterns land here. Git history preserves dropped
lessons.

---

## Recurring patterns

### 1. Un-export beats delete when the symbol has internal use

**What it looks like:** Knip flags an exported symbol; grep shows no
external consumers, but the declaration IS still referenced inside
its own file. Minimal fix: drop the `export` keyword and keep the
declaration.

**Signal:** 13 first-attempt approves across 5 runs (25954071067,
28696960513, 29631711896, 30145767542, 30686218402) — symbols
grouped by shape below.

**Guidance for future Agent A:** Before proposing deletion, grep the
declaring file for internal uses. Four load-bearing shapes recur:

- **Internal type reference** (dominant) — the flagged type is used
  inside another `interface`/`type` body in the same file, as a
  field or parameter type. Covers `SvgSanitizeWarning`,
  `HreflangAlternate`, `ProviderCallInput`, `BuildHistory`,
  `HeartbeatFn`, `StorageEstimateFn`.
- **Default parameter fallback** — `function foo(param = X)`.
  Covers the `*_DEFAULT_MODEL` constants and
  `defaultComponentIdGenerator`.
- **Formula/expression use** — the flagged constant appears in an
  arithmetic expression the same file evaluates. Covers
  `CHARS_PER_TOKEN`, `MIN_MAX_TOKENS`.
- **Sister-function dispatch** — a `switch (kind)` inside the same
  file calls the flagged symbol. Covers `resolveEmbeddedRef`.

Also covers internal helper classes thrown-and-caught within one
module (`AssetApiError`) — the class stays; only the export is dead.

The diff is one word (drop `export`); the commit message names both
what was dropped AND why the declaration survives. Cite recent
identical precedents by SHA when they exist — reviewers credit it.

### 2. Verify BOTH public-surface paths before proposing removal

**What it looks like:** Reviewers spot-check external reachability
before approving. Documenting both checks accelerates approval.

**Signal:** Both checks cited in 15+ recent approvals across every
listed run.

**Guidance for future Agent A:** A symbol is public if EITHER:

1. Its file's subpath appears in `packages/gazetta/package.json`'s
   `exports` field (`./schema`, `./format`, `./admin-api`,
   `./providers/*`, `./workers/*`, etc).
2. The symbol is re-exported from `packages/gazetta/src/index.ts`
   (the `.` entry — how most operator-facing factories reach
   consumers, even when the source file itself has no subpath).

If neither path exposes it, removal is safe. If either does,
escalate with a `public-api` skip-list entry documenting the
exposure path — do NOT propose the change.

Note: `apps/admin` is a private Vue SPA workspace with no `exports`
map, so only path 2's re-export check applies there.

### 3. Barrel re-exports are dead when consumers import canonically

**What it looks like:** A file re-exports a symbol from a sibling
module. Grep shows all in-repo consumers import directly from the
sibling (not through the barrel). The re-export line is dead; the
symbol itself is fine.

**Signal:** 6 approvals — `SharpAdapterOptions`,
`CloudflareAdapterOptions` (bypassed via `transforms/factories.ts`);
`AIAdapterFailedError`, `AIAdapterUnavailableError` (via
`ai/errors.js`); `eventFromRegistration` (via
`hooks/audit-emitter.js`); `BuildHookContextOptions` (consumers
rely on TypeScript inference from `buildHookContext`'s signature).

**Guidance for future Agent A:** When Knip flags a re-export line
(not a definition), trace where consumers actually import from. If
all bypass the barrel for the canonical source, drop only the
barrel line — confirm the canonical export still exists so the
symbol isn't stranded. Symmetric-group risk: if the same line
re-exports paired symbols (`sharpAdapter, cloudflareAdapter`) and
Knip flagged only one, escalate rather than break the pair.
