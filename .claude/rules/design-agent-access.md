# Agent access

How AI agents (coding agents, scripts, chat apps) reach Gazetta's content: in what order the ways in ship, how they write, what stops them publishing, and how they learn about changes. This sets the direction for the design pass in [#49](https://github.com/gazetta-studio/gazetta-studio/issues/49), which now covers agent access as a whole, MCP included; each piece below gets its details there.

**Status**: direction decided 2026-10-31, Q1–Q10. The #49 design pass designs the details.

**Companion docs:**
- [`design-ai-direction.md`](design-ai-direction.md): agents lead Gazetta's AI work; they act as their own principal and can't publish by default; the live view of agents' changes (Q8)
- [`ROADMAP.md`](../../ROADMAP.md): the agent access design pass (Now) and build (Next)
- Research on #49: the agent-integration discovery (2026-10-31), the MCP refresh (2026-10-24), the live-view discovery (2026-10-31)

## Discovery

From the agent-integration discovery on #49 (sources and provenance there):
- Most vendors in late 2026 ship a remote MCP server plus Agent Skills, an open standard used by Claude Code, Codex, ChatGPT, Copilot and Cursor. Several developer tools ship a CLI plus a skill (Cloudflare, Vercel, Netlify, Storyblok, EmDash, WordPress); Storyblok uses MCP for one-off changes and the CLI for bulk and CI work.
- The only benchmark found comparing a CLI with MCP for agents called it a wash. MCP is the only way into chat apps without a shell (Claude.ai, ChatGPT).
- Every way in except file edits and browser agents can go through the admin's save path (`saveManifestCore`, which takes a principal). Agent identity, audit source and run id, per-run undo, a schema check at save, page search at 5,000 pages and the live feed are shared work whichever way in ships first.
- On a developer's machine (`trust: 'none'`), a CLI, a local MCP server and file edits all run as the shell's owner; only the agent client's permission settings can stop a publish there.
- Read from code (2026-10-31): no CLI command reads or writes a page's content (`gazetta archive` changes archive state through admin routes), and the CLI has no JSON output; there's no OpenAPI document; some write routes take their body without parsing it against a schema.

## Locked decisions

### Q1 — Skills first, then a CLI, then MCP

1. An Agent Skill and `AGENTS.md` lines that `gazetta init` adds, teaching agents the content model, editing files on the local target, and `gazetta validate` ([#1622](https://github.com/gazetta-studio/gazetta-studio/issues/1622); Q4 adds template authoring).
2. CLI content commands with JSON output (Q2).
3. An MCP server for chat apps, as a thin layer over the same functions; its relation to the thin CLI is designed in #49.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| A shared core (identity, audit, schema check, page search), then CLI and MCP together | Nothing ships until all of it is done |
| MCP first, skills alongside | MCP's open questions (auth, clients lagging on the 2026-07 revision) gate everything, while the audience's agents already have a shell |
| Files and skills only, for now | No audited saves and no bulk or CI path |

### Q2 — A separate thin CLI that only calls the admin API

The CLI for agents is a separate, small client that calls a Gazetta admin's API, local (`gazetta dev`) or remote, so the admin is always the writer: saves go through its save path, and the agent's own identity is enforced on an admin that authenticates callers (not `trust: 'none'`, the local default; see Q3).

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Content commands in the `gazetta` CLI, calling the API when an admin is configured or running and writing in-process otherwise | The maintainer chose an API-only client |
| A separate CLI that falls back to writing in-process | It needs the whole core for the fallback, so it's no lighter than `gazetta` and is a second package to keep in step |

Follows from this: in CI and scripts, the client needs an admin to talk to (a hosted one, or `gazetta dev` / `gazetta admin` started for the job). The #49 pass designs the package name, how the client finds a local admin, and the MCP server's relation to it. The client is written in Go (Q8).

Instances of a multi-replica admin still see each other's changes only through the storage-backed change feed (`design-ai-direction.md` Q8); today's cache is per instance (`design-cache.md`). The first version of this decision said other instances see the change; the Fable second opinion showed that was overstated.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Leave the wording as written | A multi-instance claim the cache design contradicts |

The thin CLI has a publish command too, through the API: on a target that needs approval it creates a publish request, where `gazetta publish` refuses. Two commands named publish with different behaviour depart from team rule 7 (one word per concept); the maintainer chose to keep both and record the difference. With it, an agent with publish rights on a hosted admin can publish or request a publish through the same client.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| No publish command in the thin CLI (presets deny only `gazetta publish`) | The maintainer chose to keep publish in both, with the difference recorded |

How an agent gets its own identity (upstream service identities mapped to a role, or Gazetta-issued tokens, which would amend `design-auth-rbac.md`'s no-built-in-auth lock) gets its own discovery: [#1624](https://github.com/gazetta-studio/gazetta-studio/issues/1624).

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Name the fork now; the #49 pass decides | The maintainer asked for a separate discovery first |
| Upstream identity only, decided now | The maintainer asked for a separate discovery first |

The #49 pass then designs agent principals from that discovery's outcome (product owner's sequencing).

### Q3 — "Can't publish" is enforced on hosted admins; locally, presets and a plain statement

Gazetta enforces it where it can: an agent calling an admin with its own token can't publish. On a developer's machine, the skill ships agent-client permission presets that deny `gazetta publish` and archive purge, and the docs say local use is trusted like the developer. Follows from Q2: the presets must also deny the thin CLI's publish command and publish calls to the API; the #49 pass designs them.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| A local agent principal in config | Anything the agent can run, it can edit, including that config; calling it a guarantee would overstate it |
| Docs only | Presets cost little and stop the common accident |

### Q4 — The skill ships in the npm package and `gazetta init` adds it

A `SKILL.md` and `AGENTS.md` lines ship in `gazetta`; `gazetta init` copies them into new projects; a test checks that every command the skill names exists. ROADMAP's Deferred row "Agent instructions (skills) for template developers" moves up.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| A separate skills repo and plugin | A second release to keep in step with the CLI |
| `AGENTS.md` lines only, until the MCP server ships | Delays the cheapest, most-adopted piece behind the most uncertain one |

The skill covers both jobs a coding agent does in a Gazetta project: editing content, and writing templates and schemas (the template contract, Zod schemas, `Content<T>`, custom editors), each part with its drift check.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Template authoring stays a separate Deferred row | Two skills for the same agent in the same project: two install steps and two drift tests |

### Q5 — A public, versioned admin API with an OpenAPI document; the admin is one of its clients

The admin API becomes a public, versioned API with an OpenAPI document, designed contract-first. The admin UI, the thin CLI, MCP and any script or LLM app are all clients of the same public API; there is no separate private API for the admin.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Internal OpenAPI, generated from Zod, not promised as public | The maintainer chose a public, versioned API |
| A public set of routes, with the admin's other routes kept internal | The maintainer chose one API that the admin uses too |
| No OpenAPI; CLI commands and MCP tools are the only contracts | No shared contract between the CLI, MCP and the admin |

Follows from this and `feature-design-process.md`'s MCP schema discipline (admin-API routes use the Zod schemas under `admin-api/schemas/`): every route parses its input with its Zod schema, and the OpenAPI document is generated from those schemas. Its cost: routes shaped for the Vue admin become a public contract. The #49 pass designs the versioning scheme and the contract.

The OpenAPI marks dev-only routes (`/__validation`, `/__reload`, the dev playground) and the preview's draft-overrides format (internal per `design-editor-ux.md`) as unversioned. They are in the same API, so there is still no private API; everything agents use (content, publish, history, validation, assets) is versioned, and the admin uses those same routes.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| All public and versioned, as first decided | Freezes the editor's draft lanes, which `design-editor-ux.md` keeps internal |

v1 is promised after the route changes already planned in Now land (review-workflow routes, publish requests and removals on `POST /api/publish`, rollback requests, media's routes, live check's on-demand route); until then the API is published as a preview, and the thin CLI targets v1.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Promise v1 now | v2 likely within weeks, as the planned route changes land |
| Version per route group | Several version lines to track |

The public API carries a bulk save that records one revision per agent run, which per-run undo builds on: one save is one revision, and a target keeps the last 50 (`design-publishing.md`).

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Leave it to #49, no mention now | Risk of a v1 contract with only per-item saves |

### Q6 — Agents learn about changes from the live feed and webhooks

The change feed the live view needs (`design-ai-direction.md` Q8), plus webhooks ([#195](https://github.com/gazetta-studio/gazetta-studio/issues/195)) signed per the Standard Webhooks spec.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| MCP subscriptions only | Reach only MCP clients, which come third (Q1) |
| Nothing; agents poll or a person prompts them | Agents can't react to a teammate's or another agent's change |

### Q7 — Browser agents act as the signed-in person; the docs say so

Browser and computer-use agents driving the admin act with the signed-in person's rights, including publishing. The docs say so and point to the CLI or API with an agent token for limited rights; the admin keeps its accessible names complete.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Detect and label them in the audit log | User agents can claim anything, so the label would be unreliable |
| No statement | Users would assume the "can't publish" rule covers them |

### Q8 — The thin CLI is written in Go

One binary for macOS, Linux and Windows (x64 and arm64), cross-compiled with Go's built-in targets; its API client is generated from the OpenAPI document (Q5). It is the repo's first non-TypeScript code: a CI job, a Dependabot ecosystem and a toolchain to learn. A release tool (for example goreleaser) is a separate choice for the maintainer.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Rust | Slower builds, and cross-compiling needs more setup per target; its gains matter less for a thin HTTP client |
| TypeScript compiled to one binary (Bun or Deno compile, Node SEA) | Binaries of 50–100 MB with a JS runtime inside each |

The skill (npm) and the commands it names (the Go binary) are two releases kept in step: Q4's reason for rejecting a separate skills repo partly applies to the chosen design too. The npm package's drift test needs the binary, and the #49 pass picks how users install it (per-platform npm packages, like esbuild and Biome, or an installer).

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Revisit Q4 | Reopens a decision made the same evening |

The bots can't check Go cuts yet (feature-bot's reviewer tells tests from implementation by TypeScript paths; the runners install Node only; Biome doesn't format Go), so the product owner files the Go cuts and the REVIEW PRS session builds them; Go support for feature-bot and fix-bot is a later issue.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Bot support for Go before any Go cut is filed | Delays the CLI behind bot and workflow changes |

### Q9 — The Go CLI is for content creators; the `gazetta` CLI is for developers

The thin Go CLI (Q2, Q8) serves people who don't develop templates (content creators) and their agents. The `gazetta` CLI serves developers.

Decided: maintainer, 2026-10-31 (#1623)

Open for the #49 pass: content creators won't have the `gazetta` npm package, so their agents need another way to get the content part of the skill (Q4), for example from the Go CLI.

### Q10 — Both CLIs are built for people and for agents

Both CLIs are designed to be used by people and by AI agents: readable output by default and JSON output on request, flags for everything a prompt would ask, and plain error messages. Follows from this: the `gazetta` CLI, which has no JSON output today, gets it.

Decided: maintainer, 2026-10-31 (#1623)

## What this changes in the plan

Follows from Q1–Q10.
- ROADMAP's "MCP server design pass" becomes "Agent access design pass" (#49), and "MCP server build" becomes "Agent access build".
- The skill (#1622) is the first step, in Now; the Deferred row for agent instructions goes.
- The #49 pass designs: agent principals (after the identity discovery, #1624), the agent-client permission presets, audit source and run id, per-run undo, the schema check at save, page search, the thin CLI for content creators (name, discovery of a local admin, commands, output for people and agents, how its users' agents get the skill, release and distribution), JSON output for the `gazetta` CLI, the public API contract, its versioning and v1 cut-off, the bulk save, the MCP server and its relation to the thin CLI, and the live view (`design-ai-direction.md` Q8).
