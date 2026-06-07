# Storybook stories are the bot's executable spec for admin-shell UX

> Context: this decision came out of the "next feature-bot candidate" grilling (2026-06-07). The candidate chosen is review-workflow MVP ([#199](https://github.com/gazetta-studio/gazetta-studio/issues/199)); this ADR captures the load-bearing decision that de-risks its UX cuts. The review-workflow specifics live in [`.claude/rules/design-review-workflow.md`](../../.claude/rules/design-review-workflow.md).
>
> **Correction (2026-06-07, same day):** an earlier draft of this ADR framed the decision as "**adopt** Storybook," reversing a supposed "no Storybook" deferral. That premise was false and never verified before writing (a rule-39 / "verify before asserting" miss). **Storybook was already set up in this repo** — `@storybook/vue3-vite ^10.3.6`, an `npm run storybook` script, `addon-a11y` + `addon-themes`, and six existing `.stories.ts` files (`ArchiveBanner`, `ValidationBanner`, `AssetAltEditor`, `ConflictDiffView`, `AssetFocalPointEditor`, plus a `__storybook__/smoke.stories.ts`). The "40+ components / not worth the setup" line in `css-theming.md` was already stale. The real, still-valid decision is narrower and is what this ADR now states.

The decision: **stories are feature-bot's executable spec for admin-shell UX cuts.** A human authors a component's `.stories.ts` (the design decision — states, layout, copy, testids); feature-bot then implements the component to satisfy those stories (the mechanical work). This makes [team-preferences.md rule 31](../../.claude/rules/team-preferences.md) (TDD-first when delegating to AI) cover UI cuts: the story is the failing spec, the component implementation turns it green.

This is not a new tool adoption — it is a **workflow convention on top of the Storybook that already ships**. The precedent already exists in the repo: `ArchiveBanner.stories.ts` enumerates that banner's states (live / pure-soft-delete / aliased-redirect) and documents the Krug "absence-as-state" contract in its header. The convention this ADR locks: for a UX cut delegated to the bot, the story is authored *first* (by a human) and the component is built *to* it.

Stories use the existing format — `.stories.ts` with `Meta` / `StoryObj` from `@storybook/vue3-vite` (NOT `.stories.tsx`; the repo's six stories are all `.ts`).

## The decision in one line

The bottleneck for feature-bot on UX cuts was never "the bot can't write Vue" — it was "the bot would *invent* UX." A human-authored story moves the UX design decision into a prior executable artifact, leaving the bot a mechanical implement-to-green task. Storybook to host it already exists; this ADR makes story-first authoring the convention for bot-delegated UX.

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

The feature-design-process gains a step for UX-bearing features: **UX-grill the surfaces → author Storybook stories (the locked spec) → run the pre-filing cut audit → migrate cuts → bot implements against stories.** The story-authoring is human work (design); the component implementation is bot work (mechanical). This is captured in `feature-design-process.md` and `dev-glossary.md`.

The bot writes components, not stories. Stories are design artifacts authored by a human (or a UX-grilling pass). A cut sub-issue for a UX component references its story file as the spec; the bot's `## Tests` is "component renders correctly for every state in `X.stories.ts`."

Review-workflow #199 is the pilot. Its three High-risk UX cuts (ReviewBanner + folded-in ReviewActions + state badges; publish-approval gate; per-target publish-approval UX) were High-risk *because* their design was unlocked — the review-workflow design pass skipped Phase 2a UX-grilling and left them as judgment calls. They got a UX-grilling pass (2026-06-07) producing the story specs in `design-review-workflow.md`; a single `ready-for-human` cut (#524) authors the `.stories.ts` files, and the bot's component cuts (#525, #528) implement to them.

This decision is **low-reversal-cost** — it's a workflow convention, not tooling lock-in (Storybook already ships and would stay regardless). Reverting means dropping the story-first convention and reverting to prose specs for bot UX cuts. It still earns an ADR on the other two criteria: **surprising without context** (a future reader sees `.stories.ts` files authored before their components and wonders why the ordering is mandated) and **real trade-off** (the A/B/C walk over where the bot's UX spec lives). The original "hard to reverse / Storybook lock-in" justification was an artifact of the false adopt-Storybook premise and does not hold.

The two surfaces (DevPlayground + Storybook) both predate this ADR. The coherence split above keeps "why two component surfaces?" answerable; it lives in this ADR and in `css-theming.md`.
