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

**Signal:** 11 first-attempt approves — `HreflangAlternate`,
`SvgSanitizeWarning`, `AssetApiError`, `AIAdapterFailedError`,
`AIAdapterUnavailableError`, `ANTHROPIC_DEFAULT_MODEL`,
`OPENAI_DEFAULT_MODEL`, `CHARS_PER_TOKEN`, `MIN_MAX_TOKENS`,
`ProviderCallInput`, `defaultComponentIdGenerator`,
`resolveEmbeddedRef` (refs: 25954071067, 28696960513, 29141159116,
29631711896, 30145767542).

**Guidance for future Agent A:** Before proposing deletion, grep the
declaring file for internal uses. Three load-bearing shapes recur:

- **Default parameter fallback** — `function foo(param = X)`. Covers
  the four `*_DEFAULT_MODEL` / `*_TOKENS` constants and
  `defaultComponentIdGenerator`.
- **Sister-function dispatch** — a `switch (kind)` inside the same
  file calling the flagged symbol. Covers `resolveEmbeddedRef`.
- **Internal type reference** — the flagged type is used inside
  another `interface`/`type` body in the same file. Covers
  `SvgSanitizeWarning`, `HreflangAlternate`, `ProviderCallInput`.

When any of these holds, the diff is one word (drop `export`), the
commit message names both what was dropped AND why the declaration
survives. When you cite a recent identical precedent (e.g. `3252d09`
for `ANTHROPIC_DEFAULT_MODEL` seeding the sibling OpenAI/tokens
family), the reviewer explicitly credits the citation.

### 2. Verify BOTH public-surface paths before proposing removal

**What it looks like:** Reviewers spot-check external reachability
before approving. Explicit documentation of both checks accelerates
approval.

**Signal:** Both checks cited in 12+ recent approvals across every
listed run.

**Guidance for future Agent A:** A symbol is public if EITHER:

1. Its file's subpath appears in `packages/gazetta/package.json`'s
   `exports` field (`./schema`, `./format`, `./admin-api`,
   `./providers/*`, `./workers/*`, etc).
2. The symbol is re-exported from `packages/gazetta/src/index.ts`
   (the `.` entry — how most operator-facing factories reach
   consumers, even when the source file itself has no subpath).

If neither path exposes it, removal is safe from an external-consumer
standpoint. If either does, escalate with a `public-api` skip-list
entry documenting the exposure path — do NOT propose the change.

### 3. Barrel re-exports are dead when consumers import canonically

**What it looks like:** A file re-exports a symbol from a sibling
module. Grep shows all in-repo consumers import directly from the
sibling (not through the barrel). The re-export line is dead; the
symbol itself is fine.

**Signal:** 4 approvals — `SharpAdapterOptions` and
`CloudflareAdapterOptions` (barrel re-exports from
`transforms/index.ts` bypassed by consumers going to
`transforms/factories.ts`); `AIAdapterFailedError` and
`AIAdapterUnavailableError` (re-exports from `alt/suggester.ts`
bypassed by consumers going to `ai/errors.js`).

**Guidance for future Agent A:** When Knip flags a re-export line
(not a definition), trace where consumers actually import from. If
they all bypass the barrel for the canonical source, drop only the
barrel line — after confirming the canonical source is still exported
(don't strand the symbol). Watch for symmetric-group risk: if the
same line re-exports paired symbols (`sharpAdapter, cloudflareAdapter`)
and Knip flagged only one, escalate rather than break the pair
asymmetrically.
