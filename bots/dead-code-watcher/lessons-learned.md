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

**Signal:** 31 first-attempt approves across 11 runs, by shape:

- Internal declaration reference (23): field/parameter of a
  same-file interface, arm of a same-file discriminated union, or
  runtime const with a same-file caller — `HreflangAlternate`,
  `SvgSanitizeWarning`, `ProviderCallInput`, `BuildHistory`,
  `HeartbeatFn`, `StorageEstimateFn`, `Severity`, `ValidatorScope`,
  `ScanSubscriber`, `TemplateImpactItem`, `RenderedFile`, four
  `CreateFragment*` union arms, `ComponentSelection`,
  `FragmentEditSelection`, `RuntimeCapability`, `CapabilityGap`,
  `ActionableMutant`, two sibling `SkipReason` unions in fix-bot
  and dead-code-watcher, plus runtime const
  `ARCHIVED_NAME_CONFLICT_MODES` used by same-file
  `resolveArchivedNameConflict` for `.has()` validation.
- Zod schema z.infer source (3): `RenameResponseSchema`,
  `NameCollisionSchema`, `ArchivedNameConflictSchema` — schema
  value has no runtime consumer, but `z.infer<typeof Schema>` type
  IS externally consumed. Un-export the schema; keep the derived
  `export type` line.
- Default parameter fallback (3): `ANTHROPIC_DEFAULT_MODEL`,
  `OPENAI_DEFAULT_MODEL`, `defaultComponentIdGenerator` — the
  `function foo(param = X)` shape.
- Formula/expression use (2): `CHARS_PER_TOKEN`, `MIN_MAX_TOKENS`
  — same-file arithmetic.

**Guidance:** grep the declaring file for internal uses before
proposing deletion. The diff is one word; the commit message names
both what dropped AND why the declaration survives. For Zod
findings, check for a same-file `z.infer<typeof Schema>` type — if
externally consumed, the schema value un-exports while the derived
type stays. Cite recent identical precedents by SHA.

## 2. Verify BOTH public-surface paths before proposing removal

**Signal:** cited in every approval across the current log window.

**Guidance:** a symbol is public if EITHER (1) its file's subpath
appears in `packages/gazetta/package.json`'s `exports` field
(`./schema`, `./format`, `./admin-api`, `./admin-api/schemas`,
`./providers/*`, `./workers/*`, etc.), OR (2) it's re-exported
from `packages/gazetta/src/index.ts` — how most operator-facing
factories reach consumers when the source file has no subpath.

Neither → removal safe. Either → file a `public-api` skip-list
entry. Private workspaces have no `exports` map, so only path 2
applies: `apps/admin` (Vue SPA) and `@gazetta/bots`
(`private: true`). **Nuance:** `admin-api/schemas` IS a public
subpath, but its barrel curates which sub-modules re-export — a
schema file whose symbols aren't in that barrel isn't reachable
via the public subpath.

## 3. Barrel re-exports are dead when consumers import canonically

A file re-exports a symbol from a sibling module; all in-repo
consumers import directly from the sibling. The re-export line is
dead; the symbol itself is fine.

**Signal:** 11 approves across 5 runs — `SharpAdapterOptions`,
`CloudflareAdapterOptions` (via `transforms/factories.ts`);
`AIAdapterFailedError`, `AIAdapterUnavailableError` (via
`ai/errors.js`); `pruneAuditEvents`,
`HistoryAuditProviderOptions`, `RecordResult`, `RecordToAllOptions`
(four barrel-only re-exports in the audit module cleared in one
cron); `eventFromRegistration` (via `hooks/audit-emitter.js`);
`BuildHookContextOptions` (inferred from `buildHookContext`'s
signature); `extractDeployUrl` (via
`deploy/cloudflare-workers.js`, tests import canonically).

**Guidance:** trace where consumers actually import from. If all
bypass the barrel, drop only the barrel line — confirm the
canonical export still exists so the symbol isn't stranded.
**Symmetric-group risk:** if the same line re-exports paired
symbols (`sharpAdapter, cloudflareAdapter`) and Knip flagged only
one, escalate rather than break the pair. **Joined-line case:**
on `export { factory, type Options }` where only the type is dead,
drop only the `type Options` clause; the paired factory stays
live.
