# The design-doc state table is the UX spec; the bot transcribes it into stories + component per cut

> Context: this decision came out of the "next feature-bot candidate" grilling (2026-06-07). The candidate chosen is review-workflow MVP ([#199](https://github.com/gazetta-studio/gazetta-studio/issues/199)); this ADR captures the load-bearing decision that de-risks its UX cuts. The review-workflow specifics live in [`.claude/rules/design-review-workflow.md`](../../.claude/rules/design-review-workflow.md).
>
> This ADR was revised twice the same day (2026-06-07) as two premises were corrected. Both corrections are recorded below the decision; the decision text is the final form.

The decision: **for a UX cut delegated to feature-bot, the human-authored spec is the state table locked in the design doc during the UX-grilling pass** (per [`feature-design-process.md`](../../.claude/rules/feature-design-process.md) Phase 2a) — the enumerated states with exact copy + `data-testid`s. The bot, within the component cut, **transcribes that locked table into the component's `.stories.ts` AND implements the `.vue` to satisfy it**, with the story executing green under `@storybook/test-runner` in CI. One cut produces story + component + green run. This makes [team-preferences.md rule 31](../../.claude/rules/team-preferences.md) (TDD-first when delegating to AI) cover UI cuts: the design-doc state table is the failing spec, the component+story turn it green.

This is a **workflow convention on top of the Storybook that already ships** — not a tool adoption. The repo already has `@storybook/vue3-vite`, an `npm run storybook` script, and six `.stories.ts` files (`ArchiveBanner.stories.ts` is the banner precedent — it enumerates a banner's states and documents the Krug "absence-as-state" contract in its header). This ADR adds two things: (1) the story-runner (`@storybook/test-runner`) wired into CI so stories are *executed*, not just viewable; (2) the convention that a UX cut ships story + component together, both transcribed from the design-doc state table.

Stories use the existing format — `.stories.ts` with `Meta` / `StoryObj` from `@storybook/vue3-vite` (NOT `.stories.tsx`; the repo's six stories are all `.ts`).

### Why the bot authors the story (not a human), and why that isn't tautology

The earlier framing had a human hand-author each `.stories.ts` as an independent spec, with the bot implementing to it. Revised: the bot authors both story and component in one cut. The obvious objection is tautology — if the bot writes the spec (story) and the implementation (component), "renders green" proves nothing. Three things bound the risk to acceptable:

1. **The human spec already exists — in the design doc, not the story file.** The UX-grilling pass locks the state table (e.g. ReviewBanner's 9 states with exact copy + testids, the publish-gate's 5 states) in `design-review-workflow.md` *before* any cut is filed. The bot transcribes that table into a `.stories.ts`; it does not invent the states. The independent human spec is the design-doc table; the story is its machine-executable transcription.
2. **The cut's `## Acceptance` is human-written and story-independent.** Each cut sub-issue carries behavioral acceptance criteria (e.g. "actions hidden when capability missing; reject opens dialog; empty comment blocks confirm") that the bot must satisfy and that the story does not grade.
3. **Behavior tests + the tautology check still run.** Vue Test Utils unit tests (CI `admin` job) plus the reviewer's revert→fail→reapply→pass tautology check gate behavior independently of the story.

The trade accepted: fewer cuts (no separate human story-authoring cut) at the cost of the `.stories.ts` no longer being an independently-hand-authored artifact. This holds **only because** the UX-grill produced the locked design-doc state tables first. Absent those tables, bot-authors-both would be straight tautology and the human-authored-story path would be required instead.

## The decision in one line

The bottleneck for feature-bot on UX cuts was never "the bot can't write Vue" — it was "the bot would *invent* UX." The fix is to lock the UX states in the design doc (human, at UX-grill time); the bot then transcribes that table into story + component in one cut, gated by the story running green. The independent spec is the design-doc table, not the story file.

## The validation stack for a UX cut (what each layer catches)

A UX cut is gated by four layers, none of which is pixel-level visual regression (deliberately — see below):

| Layer | Catches | Where |
|---|---|---|
| `@storybook/test-runner` | story renders in every state without throwing; `play()` interactions; a11y violations | CI gate (hard-blocks) |
| Vue Test Utils unit tests | DOM structure, props, conditional rendering, emitted events, testids/copy per state | CI gate (hard-blocks) |
| Reviewer tautology check | the tests are load-bearing (revert→fail→reapply→pass) | bot loop |
| **Agent B visual self-check** | **gross visual failures** — invisible elements (color = background), overflow, collapsed/wrong layout | **bot loop (advisory verdict, not a CI gate)** |

### Agent B visual self-check — scope and honest limitation

The reviewer (Agent B) renders each new/changed story (built Storybook static, served locally), screenshots it via a Playwright helper in `bots/_lib` (reusing the `tools/mcp-dev` screenshot logic — base64 to Claude's vision), and judges it against the design-doc state table, factoring the verdict into APPROVE/REJECT.

**This is a sanity self-check, not a visual-regression gate.** It is an LLM judging rendered output against a *prose* state table, with **no independent known-good baseline image**. It reliably catches *gross* failures (a button that renders invisible, text overflowing its container, a collapsed layout) but is *lenient* on the fine-grained things pixel-diffing would catch (4px misalignment, slightly-off color, wrong font weight). Agent B checking Agent A's output is less self-grading than A-checks-A, but it is still LLM visual judgment.

**Why it lives in the bot loop, not as a CI gate:** an LLM "looks right" verdict is too lenient and non-deterministic to *block a merge*. As an advisory input to Agent B's REJECT decision it raises the floor (the bot self-corrects gross failures before opening the PR) without pretending to be a deterministic gate. **The real visual gate remains human PR review.** Pixel-level visual-regression (`toHaveScreenshot` / Chromatic) stays deferred per `css-theming.md` "Visual testing (deferred)" — this self-check does not reverse that deferral; it's a different, weaker, cheaper thing.

### Screenshots embedded in the PR (so the human reviewer sees rendered states inline)

Because human PR review is the real visual gate, the bot **embeds the same captured story screenshots in the PR body** — so the reviewer sees every rendered state inline, without checking out the branch and running Storybook.

**The mechanism, verified against how production CI bots actually do this** (researched 2026-06-07; an earlier draft of this section wrongly assumed a token-only "browser-flow upload" — corrected below):

- **There is no token-only way to get a *truly inline* image into a PR.** GitHub has no public attachment-upload API (deliberately — abuse surface: [community #28219](https://github.com/orgs/community/discussions/28219), [#29993](https://github.com/orgs/community/discussions/29993), [GitHub Docs: Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)). The purpose-built action for this case states it plainly: *"GitHub does not allow us to upload images to a comment using the API; we need to rely on other services to host the screenshots"* ([opengisch/comment-pr-with-images](https://github.com/opengisch/comment-pr-with-images)).
- **The paste-style `user-attachments` URL requires a real logged-in browser session (cookies), not a token.** The tools that produce those URLs ([tonkotsuboy/github-upload-image-to-pr](https://github.com/tonkotsuboy/github-upload-image-to-pr), [gh-attach](https://zenn.dev/atani/articles/gh-attach-github-image-upload?locale=en)) drive a browser with preserved login state. feature-bot runs headless with only `GH_TOKEN` — it has no such session — so paste-style is **not available to it**. (Smuggling login cookies in as a CI secret was rejected: security smell + breaks on session expiry/2FA.)
- **Actions artifacts are link-only, not inline.** The `artifact-url` is an authenticated download page (*"Users must be logged-in in order for this URL to work"* — [actions/upload-artifact](https://github.com/actions/upload-artifact)); `![](artifact-url)` does not render, public repo or not.

**Decision: upload the screenshots as GitHub Release assets and embed them inline via their public download URLs (`…/releases/download/{tag}/{file}.png`); delete the cut's assets when the PR merges or closes.** Token-only (`gh release upload`, the official Release-assets API), public-served raw bytes that render inline on a public repo, and — critically — **the bytes never go anywhere near `main`'s tree or history.**

**Verified end-to-end on this repo (2026-06-07)** — not assumed. Created a `bot-screenshots` prerelease, `gh release upload`'d a real 64×64 PNG, embedded `![](…/releases/download/bot-screenshots/test-shot.png)` in a throwaway issue, and loaded the rendered page in a headless browser: GitHub rendered an `<img>` with `naturalWidth/Height = 64` and `complete: true` — i.e. **the asset loaded and rendered inline**, despite the asset being served with `content-type: application/octet-stream` + `Content-Disposition: attachment` (GitHub's markdown renderer treats it as an image regardless). Unauthenticated `curl` fetched identical bytes (public repo, no auth). `gh release delete-asset` then removed it (asset count → 0). Test issue + release torn down afterward. **One caveat observed:** after delete, the *already-issued signed CDN URL* (`release-assets.githubusercontent.com`, ~50-min expiry) still served the cached bytes until its signature expired — so cleanup is "gone within minutes," not instant revocation. That's fine for an ephemeral review aid (the goal is no permanent artifact + nothing in `main`, not instant takedown); document it so no one expects an immediate 404 post-cleanup.

**Why not the feature branch (the bug that drove this):** an earlier draft chose "commit PNGs to the feature branch, 404 on merge." That's wrong on the load-bearing requirement — *keeping the bytes out of `main`.* Deleting the branch removes the branch ref, but the branch's **commits are already merged into `main`** under every strategy: squash collapses them into one `main` commit *containing the PNGs*; rebase (this repo's default) replays them onto `main`; a merge commit makes them reachable from `main`. So the raw URLs would 404 *but the bytes would be in `main`'s history forever.* Stripping the screenshot commit pre-merge is fiddly and failure-prone for an autonomous bot. Release assets sidestep it entirely — nothing screenshot-related is ever in the mergeable diff.

**Cleanup is deterministic, not hoped-for.** Screenshots are an ephemeral *during-review* aid. They live in a single rolling release (tag `bot-screenshots`); the bot uploads `cut-{N}-{component}-{state}.png` assets when it opens the PR, and **deletes that cut's assets** (`gh release delete-asset`) when the PR merges or closes (a step in the merge/close path or a small scheduled reconciler that prunes assets whose PR is no longer open). The release itself persists as an empty housekeeping container; only the transient assets come and go. No `main` bloat, no per-run branch churn, no third-party dependency.

**Best-effort + mandatory fallback:** the upload-and-embed is best-effort and **must never block the PR.** On any failure (upload errored, capture failed), feature-bot opens the PR *without* the screenshots plus a one-line note (`_(story screenshots unavailable — run `npm run storybook` on the branch)_`) and logs it. Images are an enhancement, never a dependency. Symmetrically, a cleanup failure must not block the merge — the scheduled reconciler is the backstop that prunes orphaned assets.

**Full options landscape (all verified 2026-06-07; recorded so this isn't re-litigated — it was re-decided several times before landing here):**

| Host | Inline image? | Token-only headless? | Keeps bytes out of `main` | Autonomous-reliable | Verdict |
|---|---|---|---|---|---|
| Paste / comment / discussion asset (`user-attachments`) | ✅ | ❌ — asset pipeline is browser-cookie-only, not token ([community #46951](https://github.com/orgs/community/discussions/46951), [cli/cli#13256](https://github.com/cli/cli/issues/13256)) | ✅ | — | **Impossible for a token bot** |
| Actions artifact | ❌ — auth'd download page, not raw bytes ([upload-artifact](https://github.com/actions/upload-artifact)) | ✅ | ✅ | ✅ | Rejected (not inline) |
| Feature-branch commit + `raw.githubusercontent` | ✅ | ✅ | ❌ **— commits merge into `main` under squash/rebase/merge; the bug above** | ⚠️ pre-merge strip is fiddly | Rejected — bytes reach `main`'s history |
| Free external host (ImgBB / Catbox / Cloudinary) | ✅ | ✅ | ✅ | ❌ — link rot, 403/429 rate limits, API-key secret or zero control, 3rd-party ToS, images leave infra | Rejected — weakest for an unattended bot |
| Wiki repo (`raw.githubusercontent.com/wiki/…`) | ✅ | ✅ | ✅ (separate `.wiki.git`) | ✅ | Viable — but needs wiki enabled + obscure mechanism |
| **Release asset + delete-on-merge (chosen)** | ✅ | ✅ (`gh release upload`) | ✅ (never on the branch) | ✅ official API, deterministic cleanup | **Chosen** |

Release-asset was chosen over wiki (the other strong off-`main` option) because it uses the official Release-assets API rather than the obscure `.wiki.git` mechanism and needs no repo feature toggled on; over the free hosts because an autonomous bot shouldn't depend on a third party that can rate-limit or vanish; and over the feature-branch commit because that one fails the actual requirement (bytes stay out of `main`).

## Why Storybook over the alternatives

Three approaches for *where the bot's UX spec lives* were walked from maintainer / bot / ROADMAP / process / cold-pickup POVs. (Setup cost is **zero** for the Storybook option — it already ships; the earlier draft's "high setup cost" was the false-premise error corrected above.)

| | Approach | Executable spec? | Coherence cost |
|---|---|---|---|
| **A (chosen)** | Story (`.stories.ts`) = bot spec, on the existing Storybook | **Yes** — a story enumerates every state and runs as an artifact | Needs the DevPlayground-vs-Storybook split stated (below) |
| B | Extend the DevPlayground to host component states | Partial — live preview, not a runnable artifact | Low (one surface) |
| C | Lock specs as static prose (ASCII mockups, states, copy, testids) in the design doc | No — prose | None |

We picked **A** because:

1. **Executable spec beats prose spec for the bot.** A `.stories.ts` file is machine-readable, enumerates every component state, and is a runnable artifact. That is exactly the rule-31 TDD-first contract applied to UI — the bot implements against green stories, it does not guess at states. B's live preview isn't a runnable artifact; C's prose isn't executable at all.
2. **Zero marginal cost — Storybook already ships, with a banner-story precedent.** A would be "heavyweight" only if it meant standing up tooling. It doesn't: `@storybook/vue3-vite` is installed, six stories exist, and `ArchiveBanner.stories.ts` already demonstrates state-enumeration for a banner. Choosing A is "follow the existing pattern," not "adopt a tool." B and C would *ignore* working infrastructure to invent a weaker spec surface.
3. **It removes the risk wholesale rather than routing around it.** The discarded fallback (file the UX cuts as `ready-for-human`, bot does only backend) keeps the risky cuts off the bot but also keeps them off the bot permanently. Authoring the stories first lets **all** of a feature's cuts stay bot work.

## The coherence split (DevPlayground vs Storybook)

This repo has **two** component-isolation surfaces — the **DevPlayground** (`/admin/dev`, which `design-validation.md` extends with an Impact tab) and **Storybook** (already installed, six stories). They coexist; the split must be explicit so it doesn't read as accretion:

- **DevPlayground** — template live-preview *with real content*. Template-developer turf: "does my template render this page's content correctly?"
- **Storybook** — admin-shell component states (banners, dialogs, badges, action bars) *as design + bot spec*. CMS-developer turf: "what are this component's states, and is its implementation correct against them?"

A component belongs in Storybook when it's admin-shell chrome with discrete states a human designs and a bot implements. It belongs in DevPlayground when it's a content template previewed against author content. The two do not overlap. (Both already existed before this ADR; the ADR states the boundary, it doesn't create either surface.)

## Consequences

The feature-design-process gains a step for UX-bearing features: **UX-grill the surfaces → lock the state tables (states/copy/testids) in the design doc → run the pre-filing cut audit → file cuts → bot transcribes each table into story + component, story runs green.** The state-table authoring is human work (design, at UX-grill time); the story + component are bot work (mechanical transcription). Captured in `feature-design-process.md` and `dev-glossary.md`.

A UX cut's `## Tests` is "component renders correctly for every state in `X.stories.ts`, which the bot authors from the design-doc state table; `X.stories.ts` runs green under `@storybook/test-runner` in CI." The story is built **within** the component's cut, not as a separate prior cut.

`@storybook/test-runner` is wired into CI so stories execute (not merely view). Without it, "renders green" is unverifiable and the contract is aspirational; with it, the story is a real gate. This is the one infra addition the ADR mandates.

Review-workflow #199 is the pilot. Its High-risk UX cuts (ReviewBanner + folded-in ReviewActions + state badges; publish-approval gate UX) were High-risk *because* their design was unlocked — the review-workflow design pass skipped Phase 2a UX-grilling. They got a UX-grilling pass (2026-06-07) producing the locked state tables in `design-review-workflow.md` (ReviewBanner ×9, publish-gate ×5). Each UX cut now transcribes its slice of those tables into stories + component.

This decision is **low-reversal-cost** — a workflow convention, not tooling lock-in (Storybook already ships; the only added infra is `@storybook/test-runner`, itself cheap to remove). It earns an ADR on the other two criteria: **surprising without context** (a future reader sees the bot authoring both `.stories.ts` and `.vue` and must understand the design-doc table is the real spec, not the story) and **real trade-off** (bot-authors-both accepts bounded tautology risk for fewer cuts — see the "why that isn't tautology" section).

The two surfaces (DevPlayground + Storybook) both predate this ADR. The coherence split above keeps "why two component surfaces?" answerable; it lives here and in `css-theming.md`.

## Correction history

This ADR was revised twice on 2026-06-07, both times because a premise was asserted without verification (the rule-39 / "verify before asserting" failure mode):

1. **"Adopt Storybook" → "Storybook already ships."** The first draft framed the decision as adopting Storybook and reversing a "no Storybook until 40+ components" deferral in `css-theming.md`. False: the repo already had `@storybook/vue3-vite ^10.3.6`, `npm run storybook`, `addon-a11y` + `addon-themes`, and six `.stories.ts` files. The deferral line was already stale. Corrected to: Storybook exists; this ADR adds a workflow convention (+ the test-runner) on top of it.
2. **"Human authors stories" → "bot transcribes the design-doc table."** The second draft kept a separate `ready-for-human` cut (#524) where a human hand-authors all `.stories.ts`, with the bot implementing to them. Revised (maintainer decision): the bot authors story + component together within each UX cut, transcribing the human-locked design-doc state table. The cut that would have authored stories (#524) is repurposed into "wire `@storybook/test-runner` into CI" — the gate the stories execute under; story authoring folds into the component cuts. The independent human spec moves from the hand-written story file to the design-doc state table + the cut's `## Acceptance`.
