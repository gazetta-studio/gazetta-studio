# Storybook hosts admin-shell component states as bot-executable UX specs

> Context: this decision came out of the "next feature-bot candidate" grilling (2026-06-07). The candidate chosen is review-workflow MVP ([#199](https://github.com/gazetta-studio/gazetta-studio/issues/199)); this ADR captures the load-bearing tooling decision that de-risks its UX cuts. The review-workflow specifics live in [`.claude/rules/design-review-workflow.md`](../../.claude/rules/design-review-workflow.md).

We adopt **Storybook** as the surface where admin-shell UI components are designed (states, layout, copy) and where those designs are captured as **stories that serve as the bot's executable spec**. A human authors the stories (the design decision); feature-bot implements the component to satisfy them (the mechanical work). This makes [team-preferences.md rule 31](../../.claude/rules/team-preferences.md) (TDD-first when delegating to AI) cover UI cuts: the story is the failing spec, the component implementation turns it green.

This reverses the standing "no Storybook" call in [`css-theming.md`](../../.claude/rules/css-theming.md) ("Design-system-level visual review → Storybook or Histoire. Not worth the setup until there are 40+ components or a design-systems contributor"). That call was made about **visual-regression testing** — a different use case than **design-then-spec-for-bot-execution**. The trigger it waited for ("40+ components") is plausibly crossed by the committed UX-heavy feature wave this quarter (review-workflow UX, collaboration v1 comments UI, per-field translation UI, [#196](https://github.com/gazetta-studio/gazetta-studio/issues/196) large-site editor, [#103](https://github.com/gazetta-studio/gazetta-studio/issues/103) creation UX). Adopting Storybook now is prioritize-enablers timing, not heavyweight-for-3-components.

## The decision in one line

The bottleneck for feature-bot on UX cuts was never "the bot can't write Vue" — it was "the bot would *invent* UX." Storybook moves the UX design decision into a prior, human-authored, executable artifact (the story), leaving the bot a mechanical implement-to-green task.

## Why Storybook over the alternatives

Three approaches were walked from maintainer / bot / ROADMAP / process / cold-pickup POVs:

| | Approach | Executable spec? | Setup cost | Coherence cost |
|---|---|---|---|---|
| **A (chosen)** | Storybook; stories = bot spec | **Yes** — stories + play functions are a test artifact the bot runs | High (net-new tooling) | Needs a DevPlayground-vs-Storybook split story |
| B | Extend the existing DevPlayground to host component states | Partial — live preview, not a runnable test artifact | Medium | Low (one surface) |
| C | Lock specs as static artifacts (ASCII mockups, states, copy, testids) in the design doc | No — prose | Low | None |

We picked **A** because:

1. **Executable spec beats prose spec for the bot.** A `.stories.tsx` file is machine-readable, enumerates every component state, and runs as a test. That is exactly the rule-31 TDD-first contract applied to UI — the bot implements against green stories, it does not guess at states. B's live preview isn't a runnable artifact; C's prose isn't executable at all.
2. **The UX wave justifies the investment.** A is "heavyweight for 3 components" only if review-workflow's UX is a one-off. It isn't — a wave of UX-heavy features is committed this quarter, and Storybook is shared infrastructure for all of them. The pilot is review-workflow; the payoff is the wave.
3. **It removes the risk wholesale rather than routing around it.** The discarded fallback (file the UX cuts as `ready-for-human`, bot does only backend) keeps the risky cuts off the bot but also keeps 3 cuts off the bot permanently. Locking the UX in stories first lets **all** of a feature's cuts stay bot work.

## The coherence split (DevPlayground vs Storybook)

This repo already has a component-isolation surface — the **DevPlayground** (`/admin/dev`), which `design-validation.md` extends with an Impact tab. Adding Storybook creates two surfaces, so the split must be explicit:

- **DevPlayground** — template live-preview *with real content*. Template-developer turf: "does my template render this page's content correctly?" Stays as-is.
- **Storybook** — admin-shell component states (banners, dialogs, badges, action bars) *as design + bot spec*. CMS-developer turf: "what are this component's states, and is its implementation correct against them?"

A component belongs in Storybook when it's admin-shell chrome with discrete states a human designs and a bot implements. It belongs in DevPlayground when it's a content template previewed against author content. The two do not overlap.

## Consequences

The feature-design-process gains a step for UX-bearing features: **UX-grill the surfaces → author Storybook stories (the locked spec) → run the pre-filing cut audit → migrate cuts → bot implements against stories.** The story-authoring is human work (design); the component implementation is bot work (mechanical). This is captured in `feature-design-process.md` and `dev-glossary.md`.

The bot writes components, not stories. Stories are design artifacts authored by a human (or a UX-grilling pass). A cut sub-issue for a UX component references its story file as the spec; the bot's `## Tests` is "component renders correctly for every state in `X.stories.tsx`."

Review-workflow #199 is the pilot. Its three High-risk UX cuts (ReviewBanner / ReviewActions + state badges; publish-approval gate; per-target publish-approval UX) were High-risk *because* their design was unlocked — the review-workflow design pass skipped Phase 2a UX-grilling and left them as judgment calls. They get a UX-grilling pass producing stories before the migration files them as bot cuts.

Reversing this is meaningful cost: Storybook config, the stories written against it, and CI wiring would all be removed, and the design-then-spec workflow would revert to prose specs. Tooling lock-in plus workflow change — the ADR bar (hard to reverse, surprising without context, real trade-off) is met.

Storybook setup cost is real and front-loaded. If the UX wave does *not* materialize as committed, this decision was premature and B (extend DevPlayground) would have been right. The contingency was confirmed at decision time (2026-06-07): the wave is committed for this quarter. If a future quarter's roadmap shows the UX wave stalled and Storybook underused, revisit whether to retire it back into DevPlayground.

A future reader seeing both `/admin/dev` and a Storybook setup needs the coherence split above to not read it as accretion. The split lives in this ADR and in `css-theming.md` (which is updated to point here rather than asserting "no Storybook").
