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

**Signal:** 13 first-attempt approves across 4 runs, by shape:

- Same-file union arm (6): four sibling `CreateFragment*` result
  arms narrowed by callers via `.code === '<TAG>'` on the still-
  exported `CreateFragmentResult`; `ComponentSelection` and
  `FragmentEditSelection` as members of the still-exported
  `EditorSelection` discriminated union.
- Same-file field type (6): `RenderedFile` (types
  `RenderOutput.files` plus two local arrays), `RuntimeCapability`
  (used by `CapabilityGap.capability` + `Set<>` construction in
  `inspectTarget`), `CapabilityGap` (`TargetCapabilities.gaps`
  element plus local array), `ActionableMutant`
  (`FileSummary.mutants` element plus local `actionable` array),
  two sibling `SkipReason` unions in fix-bot and dead-code-watcher
  (each types the same-file `SkipEntry.reason` + `SkipRule.reason`
  fields).
- Runtime const with same-file caller (1):
  `ARCHIVED_NAME_CONFLICT_MODES` used by
  `resolveArchivedNameConflict` for `.has()`-based mode validation.

**Guidance:** grep the declaring file for internal uses before
proposing deletion. The diff is one word; the commit message names
both what dropped AND why the declaration survives. Cite recent
identical precedents by SHA. **Symmetric-group signal:** when a
sibling union of N members is progressively un-exported over
several runs (four `CreateFragment*` arms in one run, two
`EditorSelection` arms in another), the pattern often shows up
member-by-member as Knip catches them — no need to escalate.

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
