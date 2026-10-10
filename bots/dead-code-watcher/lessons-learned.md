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

**Signal:** 25 first-attempt approves across 7 runs, by shape:

- Same-file field / parameter / element type (14): `RenderedFile`,
  `RuntimeCapability`, `CapabilityGap`, `ActionableMutant`,
  `SpawnLike`, `AssetAdapterResolver`, `DecisionAction`,
  `CandidateSeverity`, `SkillSeverity`, `SkipRule`, and four
  `SkipReason` unions in fix-bot / dead-code-watcher /
  mutation-area-picker / review-bot — each typing their file's
  `SkipEntry.reason` / `SkipRule.reason` fields.
- Same-file discriminated-union arm (6): four `CreateFragment*`
  arms (`Ok`, `LiveConflict`, `ArchivedConflict`, `InvalidMode`)
  of `CreateFragmentResult`; `ComponentSelection` and
  `FragmentEditSelection` arms of `EditorSelection`.
- Runtime const / function with same-file caller (5):
  `ARCHIVED_NAME_CONFLICT_MODES` (used by same-file
  `resolveArchivedNameConflict` for `.has()` validation);
  `DEFAULT_INCLUSION_CONFIG` and `DEFAULT_EVICTION_CONFIG`
  (default-parameter fallbacks for same-file collectors);
  `readReviewerLog` (called by same-file `tailReviewerLog` /
  `pruneReviewerLog`); `cliMain` (called by same-file script-entry
  IIFE).

**Guidance:** grep the declaring file for internal uses BEFORE
proposing deletion. The diff is one word (drop `export`); the
commit message names both what un-exported AND why the
declaration survives. For Zod findings specifically, check for a
same-file `z.infer<typeof Schema>` — if the derived type IS
externally consumed, un-export the schema value while the
`export type` line stays. Cite recent identical precedents by SHA.
Four separate bots now carry un-exported `SkipReason` unions on
the same `SkipEntry.reason` / `SkipRule.reason` shape — this is
the strongest-supported sub-pattern in the window; cite one when
the next bot's `SkipReason` surfaces.

## 2. Verify BOTH public-surface paths before proposing removal

**Signal:** cited in every approval across the current window.

**Guidance:** a symbol is public if EITHER (1) its file's subpath
appears in `packages/gazetta/package.json`'s `exports` field
(`./schema`, `./format`, `./admin-api`, `./admin-api/schemas`,
`./providers/*`, `./workers/*`, etc.), OR (2) it's re-exported
from `packages/gazetta/src/index.ts` — how most operator-facing
factories reach consumers when the source file has no subpath.

Neither path → removal safe. Either path → file a `public-api`
skip-list entry. Private workspaces have no `exports` map, so
only path 2 applies: `apps/admin` (Vue SPA) and `@gazetta/bots`
(`private: true`). **Nuance:** `admin-api/schemas` IS a public
subpath, but its barrel curates which sub-modules re-export — a
schema file whose symbols aren't in that barrel isn't reachable
via the public subpath.
