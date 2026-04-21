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
