# AI direction

Where Gazetta's AI work goes: forms, AI helpers in forms, agents operating the CMS, or a chat panel in the admin. Resolves [#1485](https://github.com/gazetta-studio/gazetta-studio/issues/1485). This is a strategy decision; each feature it orders gets its own design pass.

**Status**: decided 2026-10-31, Q1–Q8.

**Companion docs:**
- [`ROADMAP.md`](../../ROADMAP.md): where the items below sit
- [#49](https://github.com/gazetta-studio/gazetta-studio/issues/49): the MCP server design pass, whose starting decision ROADMAP already locks (agents save through the admin's path as their own principal, audited, can't publish by default)
- [`design-ai.md`](design-ai.md): the `ai/` layer and providers that helpers in forms reuse
- [`design-tutorial.md`](design-tutorial.md): the Stage 1 tutorial (Q7)
- Research: the discovery comment on #1485 (2026-10-30): vendors, adoption surveys, fit with Gazetta's model, cost per layer

## The layers

1. **Forms**: schema-generated forms and custom editors.
2. **AI helpers in forms**: alt text (shipped), translation (planned, #1167/#192).
3. **Agents** operating the CMS through MCP or the API (#49), or by editing files.
4. **A chat panel** in the admin that edits content from instructions.

## Discovery

From #1485's research (2026-10-30; sources and provenance there):
- Developers, Gazetta's first audience (#1416): agent use about 31% in 2025, 59% in 2026 (Stack Overflow). Content teams: 28% experiment with agents, 3% call them core (CMI 2026).
- Every vendor with an agent (Sanity, Contentful, Storyblok, WordPress.com) keeps a person between the agent and visitors: the agent drafts, a person approves.
- Hosted vendors (Contentful, Sanity, Storyblok) ship metered chat panels; open-source and self-hosted ones (WordPress core, EmDash, Strapi, Payload) expose MCP for the agents users bring.
- Gazetta's content is files and its targets are a sandbox, a good fit for agents. Gaps: no agent identity, no save-time schema check, no field-level diff, undo is whole-revision.
- Read from code on 2026-10-31: the publish list marks items added, modified or only on the target (`PublishItemList.vue`) with no field diff; the only field diff is the save-conflict view (`ConflictDiffView.vue`).

## Locked decisions

### Q1 — Agents lead AI work

Agents (#49) lead Gazetta's AI work. Forms and AI helpers continue at today's pace. The UI's new investment goes to reviewing what agents did, not to writing.

Decided: maintainer, 2026-10-31 (#1620)

| Rejected | Why |
|---|---|
| AI helpers in forms first, agents after | Serves non-developer authors, the smaller group for now, and leaves the developer agent path for later |
| Equal weight, alternating cuts | Both halves stay unfinished; the agent path needs several foundations (identity, audit, per-run undo) |

### Q2 — A field-level diff first; an agent-run review screen later

First a field-level diff for each modified item in the publish list and in History, reusing the conflict view's diff ([#1616](https://github.com/gazetta-studio/gazetta-studio/issues/1616)). Then, once the MCP server gives agents a run id, a review screen for one agent run: every item it touched, revert per item.

Decided: maintainer, 2026-10-31 (#1620)

| Rejected | Why |
|---|---|
| The run review screen only | Needs agent identity and run ids, which don't exist yet; the field diff helps today, for people's edits too |
| Neither; rely on Compare, the publish list and History | A reviewer approving many edits from "modified" markers approves blind |

### Q3 — Editing files with a coding agent is documented as supported

A docs page, "Edit content with your coding agent" ([#1615](https://github.com/gazetta-studio/gazetta-studio/issues/1615)): the agent edits files on the local target, `gazetta validate` checks them, and Publish is the checkpoint where a person reviews and moves content to other targets. The page states the limits: file edits skip save-time validation, review, hooks, save history and the audit log; the local target is usually in git.

Decided: maintainer, 2026-10-31 (#1620)

| Rejected | Why |
|---|---|
| Steer agents to MCP or the API only, and flag manifests changed outside a save | MCP doesn't exist yet, and developers edit files today anyway |
| Leave it undocumented until MCP ships | Users who find it don't know to validate |

### Q4 — A chat panel gets a design pass in Later, built on the MCP tools

A design pass in Later ([#1617](https://github.com/gazetta-studio/gazetta-studio/issues/1617)), built on the MCP tools: the panel is a UI over the same agent back end (identity, audit, tools, per-run undo).

Decided: maintainer, 2026-10-31 (#1620)

| Rejected | Why |
|---|---|
| Deferred, with a trigger (operator demand, or an embeddable chat client after MCP ships) | Leaves the chat panel unplanned; the maintainer chose to plan a design pass |
| A non-goal ("use your own agent through MCP") | Its back end is #49's; ruling it out isn't needed |

The MCP design pass (#49) designs its tools so the panel can reuse them. Follows from Q4 (built on the MCP tools).

### Q5 — Page metadata suggestions are the helper after translation

After translation (#1167/#192), the next helper suggests a page's SEO title, description and Open Graph text in the page's language, on the operator's key ([#1618](https://github.com/gazetta-studio/gazetta-studio/issues/1618)). It suggests text; it doesn't grade SEO, which stays a non-goal.

Decided: maintainer, 2026-10-31 (#1620)

| Rejected | Why |
|---|---|
| Summaries or excerpts | Few templates have an excerpt field; every page has metadata |
| Tag suggestion | Gazetta's model has no shared tag field; ROADMAP already defers it until after translation |
| None until asked; agents only | Authors who don't use agents get nothing new after translation |

### Q6 — The actor scenarios gain a reviewer scenario

`docs/actor-scenarios.md` gains an Operator scenario: review and publish a batch an agent made, per field, reverting one item ([#1619](https://github.com/gazetta-studio/gazetta-studio/issues/1619)). Agents act for one of the four actors, as their own principal with their own capabilities (by default they can't publish), per ROADMAP's MCP decision; they aren't a fifth actor.

Decided: maintainer, 2026-10-31 (#1620); the capability wording corrected by the maintainer the same day, after the first answer rested on a misstated ROADMAP decision.

| Rejected | Why |
|---|---|
| A fifth actor, Agent | An agent carries out a person's goals |
| Agents get the capabilities of the person they act for | An agent working for an Operator could publish, against ROADMAP's MCP decision that a person decides what reaches visitors |
| No change | The review UI (Q2) would be designed against no scenario |

### Q7 — The tutorial stays admin-only and links the agent page from Next steps

The Stage 1 tutorial keeps its admin steps; its "Next steps" links the page from Q3.

Decided: maintainer, 2026-10-31 (#1620)

| Rejected | Why |
|---|---|
| An "or ask your agent" aside in the steps | The tutorial teaches one path, and its CI spec runs its commands word for word |
| No mention | Readers who'd rather use their agent won't find the page |

### Q8 — The admin shows agents' changes as they happen; designed in the MCP design pass

When MCP tools or an external AI change content, people in the admin see it live: in the preview, the site tree, the open page, and a line saying an agent is working. The MCP design pass (#49) designs how.

Decided: maintainer, 2026-10-31 (#1620)

A proposal for that pass to start from, not a decision of this round (posted on #49):
1. The preview updates in place as the agent saves.
2. The site tree marks changed pages for a moment ("changed just now by Claude").
3. An open page without unsaved edits refreshes in place, with "See changes" opening the field diff (Q2).
4. An open page with unsaved edits shows that the agent changed it, with "See changes" and "Keep mine", before the author saves rather than at save.
5. While an agent works, one line says so and links to the agent-run review (Q2).

Discovery for it (competitors, transport, cost at the 5,000-page envelope) is posted on #49.

Today only part of this exists: in `gazetta dev`, the site-folder watcher pushes `/__reload` and the preview re-renders when a page file changes (read from code, 2026-10-31); the site tree and the open form don't refresh, and `gazetta admin` has no watcher. Real-time push is an observer layer on the save and audit events, never wired into the save handlers (`feature-design-process.md`, real-time event-source discipline), and the change feed comes from storage so it reaches every admin instance (`feature-design-process.md`, multi-instance discipline).

| Rejected | Why |
|---|---|
| Its own design pass | Two passes designing the same agent save events and identity would have to agree after the fact |
| Later, after the MCP server ships | The MCP tools and events would be designed without the live view, and an event feed is harder to add afterwards |

## What this changes in the plan

Follows from Q1–Q8. Four placements come from the answers: the agent-run review screen waits for run ids (Q2), the chat panel design pass is in Later (Q4), page metadata suggestions come after translation (Q5), and the live view is designed in the MCP design pass (Q8). The rest is the product owner's sequencing and changes through ROADMAP like any placement:

| Item | Bucket |
|---|---|
| Docs page for coding agents (#1615) | Now, under AI direction: first steps |
| Field-level diff (#1616) | Next |
| Agent-run review screen | Later, after the MCP server build |
| Chat panel design pass (#1617) | Later |
| Page metadata suggestions (#1618) | Later, after translation |
| Reviewer scenario (#1619) | Now, under AI direction: first steps |
| Live view of agents' changes | Now, as a question in the MCP design pass (#49) (Q8) |

The Stage 1 tutorial, the media editor flow (#1357) and creation UX (#103) keep their places: they're forms people use whatever agents do.

## Evidence that would reopen this

- gazetta.studio's agent-files experiment (#1273) shows agents rarely fetch its Markdown.
- Stage 1 testers or early users are mostly non-developer authors.
- Content-team agent adoption passes half in a later survey round.
