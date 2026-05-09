# Team Preferences

Validated approaches and things to avoid. Each entry: rule, then why.

1. **No auto-save in CMS.** Edits stay in memory until explicit save. Preview uses POST with draft content overrides.
   Why: Auto-save doesn't fit the CMS UX — content authors need control over when changes are persisted.

2. **Use testcontainers for Docker-based integration tests, not docker-compose.**
   Why: Testcontainers manage lifecycle programmatically — cleaner setup/teardown, no manual docker-compose up.

3. **Use data-testid attributes for Playwright selectors, not CSS classes or aria-labels.**
   Why: CSS/aria selectors are brittle — break when PrimeVue updates or labels change. Test IDs are stable.

4. **Write tests alongside new functionality, in the same commit.**
   Why: Tests added as follow-up commits get forgotten or deprioritized. Ship tested code, not code then tests.

5. **Types infer from Zod schema — single source of truth.**
   Use `type Content = z.infer<typeof schema>` and `TemplateFunction<Content>`. Don't duplicate types manually.

6. **Content, not props.** The CMS vocabulary is "content" — matches what content authors see. Don't use React terminology (props) in CMS/template code.

7. **Consistent naming across CLI, UI, and API.** If the CMS button says "Publish", the CLI command is `gazetta publish`, the API endpoint is `/api/publish`. Don't use synonyms (build, deploy, push) for the same action. One word per concept.

8. **Update docs in the same commit as the feature.** When adding or changing user-facing behavior, update getting-started.md and gazetta.studio docs in the same commit. Don't leave docs as a follow-up.
   Why: Docs that lag behind the code mislead users and create extra issues to track.

9. **npm release: bump version, lockfile, commit, tag — all together.**
   When bumping the gazetta package version:
   ```
   npm version <patch|minor|major> -w packages/gazetta
   git add packages/gazetta/package.json package-lock.json
   git commit -m "Bump gazetta to v$(node -p "require('./packages/gazetta/package.json').version")"
   git tag "v$(node -p "require('./packages/gazetta/package.json').version")"
   git push && git push --tags
   ```
   `npm version -w` updates package.json and lockfile but does NOT commit or tag (disabled for workspaces). Must do it manually.
   Why: v0.1.1 shipped with lockfile out of sync because the commit and tag were done without the lockfile.

10. **E2e test isolation: per-worker temp sites, not in-place mutation.**
   Each Playwright worker gets its own `cp -r` of `examples/starter` into `{repo}/.tmp/e2e-{workerIdx}/project/` with its own dev server on port 3100+workerIdx. Mutation tests write to the copy, never to the repo. See `tests/e2e/fixtures.ts` for the worker-scoped `testSite` fixture.
   Why: Earlier approach (git checkout in beforeEach) leaked state between tests via SSE reload timing. Temp sites eliminate the class of problem.

11. **When adding CI steps, verify assumptions locally first.**
   Before pushing CI changes, check: default parallelism settings, async import behavior, file watcher side effects, and timing differences between local and CI. One fact-check round saves multiple CI push-fix cycles.
   Why: The e2e CI setup took 5 pushes because we assumed Playwright defaults, SSE timing, and Vite import behavior without verifying.

12. **Dark mode CSS: use non-scoped `<style>` block, not `:global(.dark)` in scoped styles.**
   Scoped selectors get `[data-v-xxx]` attributes which beat `:global(.dark)` in specificity. Put dark overrides in a separate `<style>` (no `scoped`) using `.dark .component-name` selectors. Follow PreviewPanel's pattern.
   Why: ComponentTree dark mode was broken — `:global(.dark) .node-root .node-label` lost to `.node-root .node-label[data-v-xxx]`.

13. **Vite dev: pre-scan custom editors in `optimizeDeps.entries` + include JSX auto-runtime explicitly.**
   When Vite finds a new dep at runtime (after initial optimization), it fires `optimized dependencies changed. reloading` — a full page reload that wipes editor state mid-session. Custom editors under `admin/editors/*.tsx` must be listed in `optimizeDeps.entries`, and `'react/jsx-dev-runtime'` / `'react/jsx-runtime'` must be in `optimizeDeps.include` (the scanner can't see them — they're injected by esbuild at transform time).
   Why: The #122 flake took 3 diagnosis iterations to find. Symptom ("Select a component to edit") looked like a store clear bug; actual cause was Vite's lazy dep optimizer. Always investigate with CI browser console capture before speculating.

14. **Editor mount composables: capture (mount, el) as a pair — don't rely on the ref's current value at unmount time.**
   When `editorMount` ref changes (e.g. default form → custom editor), calling `editorMount.value.unmount(el)` uses the NEW instance's unmount on a container mounted by the OLD one — it's a no-op, leaving the React root behind. Next `createRoot(el)` triggers "container already has root" warning. Fix: store `current = { mount, el }` at mount time, use `current.mount.unmount(current.el)` at unmount time.
   Why: Discovered while diagnosing #122. The React warning on its own didn't break things, but it compounded with the Vite reload bug.

15. **Apply SOLID principles to every change.**
   Single responsibility (one module = one reason to change — e.g. `sidecars.ts` owns sidecar I/O, nothing else), open/closed (extend via injection — `compareTargets` takes `scanTemplates` as an option rather than hard-coding the default), Liskov (substitutable providers — `StorageProvider` contract), interface segregation (narrow interfaces like `SourceSidecarWriter { writeFor, invalidate }` rather than god objects), dependency inversion (routes depend on the `SourceSidecarWriter` interface, not on `createSourceSidecarWriter`).
   Why: Explicit user preference, reinforced in every major refactor of the performance work.

16. **Rebase is the default git strategy.**
   Main is rebase/fast-forward only — no merge commits. Branch protection on main requires linear history. Apply at every level:
   - **PR merge:** `gh pr merge --rebase` (never `--merge`). Use `--squash` only when the branch has messy intermediate commits.
   - **Updating a PR branch against main:** `git fetch && git rebase origin/main && git push --force-with-lease`. Never `git merge origin/main` into a feature branch.
   - **Resolving conflicts:** fix during rebase, `git add`, `git rebase --continue`. Don't abort to a merge.
   - **Stacked PRs:** rebase each downstream branch on its updated parent, don't cross-merge.

   Why: Linear history on main is what lets publish.yml and deploy-site.yml trust push events without re-running CI — every commit on main is a SHA that already passed CI on its PR. Merge commits create new SHAs whose validation didn't happen.

17. **Build and validate, don't spike.** When validating risky technical decisions, build the real thing in a sequence of rollback-able commits — no throwaway/spike code. Each commit must:
   - Produce real code that stays if the approach works (not demos to be deleted)
   - Be independently rollback-able (reverting restores the previous state cleanly)
   - Validate the riskiest assumptions early, as actual features rather than spike branches

   Order implementation steps by design-risk blast radius: low-risk foundational first, highest-risk architectural bets as single revertable commits near the end. If a risky step fails, reverting one commit loses one step of work — not a week of spike-then-reslice.

   Why: spikes get deleted; validated production code is permanent progress. A spike that "proves it works" still requires rewriting the real version afterward; building the real version directly means the proof *is* the progress.

18. **Build structurally right from the start — don't patch SOLID in.**
   Apply SOLID at module creation, not as an after-the-fact audit. Before writing code, identify the concerns being addressed and give each its own module; before introducing an interface, decide whether it's a single contract or a capability that not every implementation supports.

   Concretely:
   - **Before creating a file**, ask: what single reason does this have to change? If there are two, create two files.
   - **Before adding a method to an existing interface**, ask: will every implementation honor it? If not, it's a capability — create a separate interface and a type guard.
   - **Never ship stubs that throw `not implemented`** to satisfy an interface. That's LSP violation dressed as progress.
   - **Extract shared code when you first see the split concern**, not after a third caller — waiting until the 3-caller threshold (rule #15) applies to "shared utility functions," not to separating concerns that are already distinct at creation.

   When a review identifies SOLID violations, the fix is structural correction (new files, split interfaces, extracted policies), not patching. If the amendment is large enough to change the shape, amend the commit before it lands; if it already merged, land the restructure as its own commit with a clear "structural correction" message.

   Why: SOLID violations compound. A fused module with three concerns becomes three fused modules when its consumers copy the pattern. A stub-that-throws teaches callers to defensively check before every call, poisoning every downstream surface. Getting the structure right once is cheaper than fixing it in every caller later.

   Example (media v1 step 1): initial draft fused node-fs adapter, atomicity policy, and stream-interop into one 136-line filesystem provider, and stubbed `readStream`/`writeStream` on R2/S3/Azure with `throw new Error('not implemented')`. Correct structure split into three provider files (`filesystem.ts` as pure adapter, `_atomic-write.ts` for atomicity, `_stream-interop.ts` for web/node bridge) and introduced `BinaryStorage` as a separate capability interface with `isBinaryCapable()` type guard, eliminating the stubs. Amended the commit before merge — structure was wrong, not the features.

19. **Boy Scout rule — leave the code cleaner than you found it.**
   When you're passing through a file for a real change, fix the small broken things you see along the way: a pre-existing type error, a dead re-export, a stale comment, a missing test, an obvious typo. You don't need permission — that's the rule. Scope stays tight: only fix what's cheap *and* adjacent to the work you're already doing. The test for "adjacent": if the fix and the main change belong in the same logical commit, fix it; if cleaning it up would balloon the diff into unrelated territory, leave it (or file a separate commit).

   What counts as "passing through":
   - Editing a file for a real change → fair game to also fix anything obviously broken in it
   - Running `tsc --noEmit` and seeing a pre-existing error → fair game to fix if it's small
   - Running tests that pass but emit warnings → fair game to silence the warning's root cause

   What does NOT count:
   - Rewriting unrelated code "because you're in the file anyway" — that's scope creep
   - Aggressive refactors disguised as cleanup — if it's an architectural change, it deserves its own commit and design consideration

   Why: broken-window theory at the file level. A file with one pre-existing type error attracts more; a file that type-checks and tests cleanly stays that way. Small debt, cheap to fix right now, expensive to fix later when the context has evaporated.

   Example (media v1 step 5): `apps/admin/src/client/stores/editing.ts` was re-exporting `actions.open` which hadn't existed since the `useEditorActions` migration to `navigate()`. Type-checker flagged it; no runtime callers. Dropped the line as a drive-by fix in the same pass as adding the asset library store wiring.

20. **Fact-check claims before building on them.**
   When citing a competitor feature, an industry fact, an external API behavior, or anything you didn't directly verify, check it against the official source (vendor docs, GitHub releases, the actual API/SDK) before treating it as ground truth. Third-party blogs, summaries, and your own training data lie or drift. If you can't verify, say so explicitly — don't guess.

   Concretely:
   - When researching CMS features for design pressure, cite official docs URLs, not blog posts
   - When asserting "tool X does Y," verify; when you can't, say "appears to" or "claimed by" with the source
   - When a fact informs a structural decision, the decision is only as solid as the fact
   - When time is short, skip the citation — but flag the claim as unverified, not as ground truth

   Why: in the CMS feature audit (May 2026), of 27 cited claims about competitor features: 14 verified, 6 partially-correct or wrong, 5 unverifiable, 2 outright wrong. Wrong claims about Webflow's "backlinks" and Strapi's draft validation almost informed strategic decisions. The fact-check itself was cheap (~10 minutes via subagent); the cost of building on wrong claims is high.

   Example: I claimed "Contentful has contentful-merge for content models" — fact-check found no such feature in official docs. Would have proposed Gazetta features pattern-matching a thing that doesn't exist. Caught before commitment.

21. **Research informs design; design absorbs the conclusions; the research itself stays durable.**
   When deep research feeds into a design decision, capture the research durably — competitive context, fact-check findings, rejected alternatives — somewhere reusable. The design doc absorbs the conclusions; the research itself shouldn't die in a transcript.

   Where research goes:
   - **Competitive audit / external benchmarking** → `docs/audits/{topic}.md`
   - **Rejected alternatives + reasoning** → `design-{feature}.md` "Distinctive choices" section
   - **Fact-check ledger** → in the research doc itself (which claims verified, which corrected)
   - **Strategic non-goals derived from research** → `docs/non-goals.md`
   - **Strategic prioritization** → `ROADMAP.md`

   Why: the same research informs future decisions on adjacent features. Re-doing it from scratch every time is wasteful; losing the rejected-alternatives reasoning means future-me re-litigates the same debate.

   Example: the CMS feature audit produced 22 categories of features modern CMSes ship; 13 were genuinely new to the roadmap. Captured in [`docs/audits/cms-feature-audit.md`](../../docs/audits/cms-feature-audit.md), driving [`ROADMAP.md`](../../ROADMAP.md) and [`docs/non-goals.md`](../../docs/non-goals.md). Without these durable artifacts the analysis would have died with the conversation.

22. **Every kind of work has a durable artifact home; if a session ends without producing it, the work dies.**
   The resumability contract: feature designs go in `design-{feature}.md` + `-implementation.md`; ADRs go in `docs/adr/`; domain language goes in `CONTEXT.md`; research goes in `docs/audits/`; strategic priorities go in `ROADMAP.md`; non-goals go in `docs/non-goals.md`; lessons go here in `team-preferences.md`. See [`feature-design-process.md`](feature-design-process.md) for the full mapping.

   Why: long conversations produce work in many shapes. Without designated homes, only feature-design work tends to survive (because the design-doc pattern is established); strategic prioritization, research, fact-check findings, and process conventions all die in transcripts. Naming a home for each kind of work makes "is this resumable?" answerable.

23. **UX follows "Don't Make Me Think" (Steve Krug).** When designing user-facing UI, ask "what can I remove?" not "what should I add?":

   - **Absence of indicator IS a state** — show indicators only when something is NOT-default or needs attention. The default state should be visually quiet.
   - **Universal icons over jargon** — cloud-with-slash, not "Queued"; refresh icon, not "Reload page from server."
   - **Same affordances regardless of system state** when possible — e.g., save button identical online and offline; author's mental model unchanged by connection state.
   - **Plain language** — "Was edited by someone else" not "STALE conflict"; "Saved locally" not "Queued."
   - **When tempted to add a help tooltip, fix the UI instead** — if the indicator needs explanation, the indicator is wrong.

   Why: every sub-decision in UX work risks accumulating cognitive load on users. The default question for any UI element should be "can I remove this without losing meaning?" not "what should I add?"

   Example: `design-offline.md`'s sync-state visibility went through three iterations — initially 5 explicit states with "Queued" badges and numeric progress; the Krug-aligned final has a cloud-with-slash icon (synced is the absence of indicator), plain-language messages, and an identical save button online/offline. Two-thirds of the original UI surface removed without losing meaning.

24. **Validate every primitive against the 5K-page envelope.** Per [`design-scale.md`](.claude/rules/design-scale.md), Gazetta targets 5,000 pages / 20,000 assets / 50 components-per-page as the operating envelope. Every new primitive (route handler, validator, walk, lookup, sidecar, cache key) must hold there:

   - **Avoid O(N-pages) walks at request time or on hot paths.** When a check would walk the whole content tree (e.g., "find archives whose `aliasOf === X`"), build a per-edge sidecar index and `readDir` it instead — same pattern as `asset-refs` and `fragment-deps` per [`sidecars.md`](.claude/rules/sidecars.md). The sidecar pattern is the established Gazetta way; deviating from it for "cut size" is short-term thinking — retrofitting later means rewriting consumers.

   - **Check the bench cost before assuming "fast enough."** Filesystem walk at 5K pages is ~150ms cold / ~10ms warm. Cloud storage (R2/S3/Azure) walks at 5K pages project to 30–60s on real cloud (per `design-media-implementation.md`'s asset-refs measurement). Anything over the 5-second admin SLA at envelope is structurally wrong, not just slow.

   - **`design-scale.md`'s envelope is the gate, not a future goal.** Implementation cuts that say "we'll add a sidecar later if perf becomes a concern" violate this — the sidecar IS the perf design.

   - **Synthetic-site benchmarks are the gate.** When in doubt, run against `tests/_helpers/synthetic-site.ts`'s 5K-page generator (per `design-scale.md` Cut 1's perf-regression CI work).

   Why: the asset-refs sidecar grilling that locked per-edge files (`design-media-implementation.md`) was driven precisely by the 5K-page measurement (walk-on-demand at 5K = ~30s on cloud, sidecar = ~5ms). Same logic generalizes: every cross-cutting check needs a sidecar OR an explicit declaration that the walk cost is acceptable at envelope.

   Example (Cut 5 of soft-delete): purge-blocked check needs "any archive aliasing this name." Walking 5K manifests = bad; per-edge `.gazetta/alias-targets/{target}/{archive}` sidecar = `readDir`-fast. Pattern consistent with existing `asset-refs` and `fragment-deps`.

25. **Grill design docs the same as code — never lock a Q without enumerated rejected alternatives.** "We discussed it" isn't a justification; "we walked the alternatives and rejected each for documented reasons" is. When a design lock has only one option enumerated, that's a smell — re-grill before shipping.

   **How to apply:** before writing a Q's lock paragraph, list at least 2-3 alternatives. For each rejection, name the specific failure mode that disqualifies it. If only one option survives the walk, ask honestly: "did I actually evaluate alternatives or take the path of least resistance?" If the latter, re-grill.

   **Why:** design docs become enforced contracts that shape every downstream cut. Locks that were never grilled compound — Cut N starts implementing, hits the unjustified lock as a constraint, has to either work around it (creating inconsistency) or rip it out (creating churn). Re-grilling at lock time is cheap; rip-out at impl time isn't.

   Example: `design-soft-delete.md` Q10 originally locked HTML-marker-for-static + per-edge-sidecar-for-ESI as a dual mechanism. The second mechanism was speculative — both worked for both target types. Caught during Cut 3 implementation when the user asked "why two mechanisms?" Reframed to one. Cost: one commit updating the doc + impl. Avoidable cost: zero rework if the original Q10 grilling had enumerated "HTML-marker-everywhere" as an alternative.

26. **Default to test-isolation paranoia.** Every new test file: per-test fresh storage / fresh tempdir; module-level constants reviewed; no implicit sharing. Vitest's default serial-within-file mode is a soft guarantee, not a contract.

   **How to apply:** before writing the first test in a new file, write down the answer to:
   - What state is module-level vs per-test?
   - Two tests in this file run sequentially today — would they break if vitest ever ran them in parallel?
   - Two test files importing the same helper — do they share filesystem paths via `Date.now()` collision?

   When in doubt, prefer per-test fresh resources (memory storage, per-test tempdir suffix) over module-level constants. The cost is one extra setup line per test; the benefit is robustness against future vitest config changes.

   **Why:** flaky tests born from shared state are diagnosed late and expensively. The pre-existing pattern in `publish.test.ts` (`tempDir(name + Date.now())` at module scope, `beforeEach` recreate, `afterEach` rm-rf) is safe under serial-within-file but would fail under parallel-within-file. New test files inherit that fragility unless the author thinks about it explicitly.

   Example: Cut 3 archive publish tests — 5 of 7 use fresh `memoryStorage()` per test (clean isolation), 2 use module-level filesystem `tempDir`. Both safe under current vitest mode; the latter would need per-test suffixes to survive future parallelism.

27. **Label assertion provenance.** When stating UX, design, or workflow opinions, prefix with the source: "intuition," "training-data pattern match," "verified against [specific doc]," "verified against [user research]." Without the label, an opinion reads as authoritative when it might be a guess.

   **How to apply:** before writing "I think X should..." or "the right pattern is...":
   - If asserting from intuition or generic pattern memory, say so: "Intuition (un-verified): the publish dialog should gain a Schedule tab."
   - If asserting from a specific doc, cite it: "Per `design-soft-delete.md` Q10: ...".
   - If asserting from user research, name it: "Verified against the May 2026 CMS audit: ..."
   - If you don't know whether you have data or intuition, **stop and figure that out before asserting**.

   **Why:** unlabeled opinions accumulate as facts. A reader (including future-me) treats a confident statement as researched unless told otherwise; the cost of mistaking intuition for data is downstream rework when the intuition turns out wrong.

   Example: `design-scheduling.md` Q6 (admin UX) — drafted detailed surfaces (publish dialog tab, archive modal option, visibility metadata, schedule chip, dashboard) based on intuition + training-data pattern matching. Asked "are you satisfied with UX research?" Honest answer was no. Re-locked Q6 to commit only structural decisions ("publish dialog gains schedule capability") and explicitly defer detailed UX to a focused research pass. The relabel was the fix.

28. **Every feature follows the four-phase + retrospective discipline.** Per [`feature-design-process.md`](feature-design-process.md): Discovery → UX-grilling → 5K-envelope gate → Implementation-grilling → Design → Implementation → Retrospective. The grilling step splits in two: UX surface gets its own pass before implementation grilling, with a 5K-envelope gate between them.

   **Why split UX from implementation grilling:** UX choices made inside implementation grilling get compromised by implementation convenience. Same lesson as `design-scheduling.md` Q6 — when UX is implicit inside the design Qs, intuition fills the gap. Separate UX-grilling forces explicit time on the user-facing surface.

   **Why the 5K-envelope gate sits between them:** per rule 24, every primitive must hold at envelope. Catching scale issues in implementation-grilling (before lock) is cheap; catching them mid-cut means rework. The gate is a forcing function: name the cross-cutting checks the UX requires, identify their walk costs, decide whether sidecars are needed — then proceed to implementation Qs.

   **Why the retrospective:** patterns that worked but weren't named die. The session that produced rules 24-27 was retrospective in shape; without locking them durably they would have died with the conversation. Run retrospectives after feature ships, at significant milestones, when sessions end with multiple "we should remember X" observations, or when the user asks "what did we learn?"

   **How to apply mid-feature:** when starting any new feature (or significant feature milestone), open with phase 1 (Discovery), then 2a (UX-grilling — actor scenarios + user flows + Krug-lens removal), then 2b (5K-envelope gate — name primitives + walk costs + sidecar requirements), then 2c (Implementation-grilling). Land the design doc with all three grilling outputs reflected. After implementation completes, run phase 5 (Retrospective) and produce durable artifacts (new rules, doc updates, ADRs).

   Example: this rule itself is the retrospective output of the soft-delete session. The session produced rules 24-27 the same way: caught patterns mid-implementation, locked them durably so future features inherit the awareness.

29. **`data-testid` is part of every UI cut's definition of done.** Modals, banners, pickers, and any new interactive component land with `data-testid` attributes during the UI cut that creates them — not deferred to the e2e cut that needs them. Extends rule 3 ("Use data-testid attributes for Playwright selectors").

   **Why:** every modal/dialog without testids creates an opportunity for the next person to add one inconsistently. The e2e cut (typically the final cut of a sequence) becomes a junkyard of "Boy Scout" testid additions across components from many earlier cuts; each addition risks naming-convention drift, and review burden goes up because the e2e PR touches files outside its conceptual scope.

   **How to apply:** before marking a UI cut complete, grep the new component(s) for `data-testid=` and confirm every interactive element (modal root, primary action button, secondary action button, every input field used by tests) has one. Naming convention: `{feature}-{action}` for buttons (`archive-confirm`, `purge-cancel`); `{feature}-modal` for modal roots; `{feature}-{field}-input` for inputs.

   Example: soft-delete Cut 10 shipped ArchiveModal with no testids; Cut 15's e2e couldn't be written without adding 4 testids as Boy Scout fixes. Better path: Cut 10 lands with testids alongside the modal markup, Cut 15's e2e is pure scenario-writing.

30. **Forward-compat changes touch every projection layer.** When adding a field for a future foundation (e.g., a future-version `reviewState` ahead of review-workflow shipping), trace the field's path through every layer it traverses: storage → parser → typed manifest → route handler → response → audit / cache / sidecar. Skipping any layer means the field is invisible at runtime even though the unit-level contract works.

   **Why:** layered projections (whitelist parsers, type narrowing, audit-event shapes, cache-key encoders) each commit to "fields I know about." A new field invisible to one of them is silently dropped at that layer; downstream consumers see `undefined` and the gate that should activate stays inert. Unit tests of the helper pass; integration tests fail.

   **How to apply:** when introducing a field for forward-compat (no current consumer), enumerate the layers explicitly:
   - Manifest parser (`parseXManifest` whitelist) — does the field round-trip through the whitelist?
   - Save handler — does the field survive the save → re-load cycle?
   - Audit shape — does the field appear in audit metadata if relevant?
   - Cache key — does the field affect cache invalidation?
   - Sidecar shape — does the field affect any per-edge sidecar?

   Land a route-level integration test that exercises the full save → read chain; unit-level helper tests aren't sufficient.

   Example: soft-delete Cut 14's `reviewState` field — the helper functions (`buildAutoWithdrawEvent`, `archiveReviewMetadata`) had passing unit tests, but the route-level integration tests failed because `parsePageManifest` whitelisted fields and dropped `reviewState`. Required adding `parseReviewFields` passthrough alongside `parseArchiveFields`. The integration test caught the gap; without it, the forward-compat code would have been silently dead until review-workflow shipped.
