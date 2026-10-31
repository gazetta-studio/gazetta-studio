# Agent access

How AI agents (coding agents, scripts, chat apps) reach Gazetta's content: in what order the ways in ship, how they write, what stops them publishing, and how they learn about changes. This sets the direction for the design pass in [#49](https://github.com/gazetta-studio/gazetta-studio/issues/49), which now covers agent access as a whole, MCP included; each piece below gets its details there.

**Status**: direction decided 2026-10-31, Q1–Q7. The #49 design pass designs the details.

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
- Read from code (2026-10-31): the CLI has no content commands and no JSON output; there's no OpenAPI document; some write routes take their body without parsing it against a schema.

## Locked decisions

### Q1 — Skills first, then a CLI, then MCP

1. An Agent Skill and `AGENTS.md` lines that `gazetta init` adds, teaching agents the content model, editing files on the local target, and `gazetta validate` ([#1622](https://github.com/gazetta-studio/gazetta-studio/issues/1622)).
2. CLI content commands with JSON output (Q2).
3. An MCP server for chat apps, over the same client functions.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| A shared core (identity, audit, schema check, page search), then CLI and MCP together | Nothing ships until all of it is done |
| MCP first, skills alongside | MCP's open questions (auth, clients lagging on the 2026-07 revision) gate everything, while the audience's agents already have a shell |
| Files and skills only, for now | No audited saves and no bulk or CI path |

### Q2 — A separate thin CLI that only calls the admin API

The CLI for agents is a separate, small client that calls a Gazetta admin's API, local (`gazetta dev`) or remote, so the admin is always the writer: saves go through its save path, the agent's own token is enforced, and the live feed and other admin instances see the change.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Content commands in the `gazetta` CLI, calling the API when an admin is configured or running and writing in-process otherwise | The maintainer chose an API-only client |
| A separate CLI that falls back to writing in-process | It needs the whole core for the fallback, so it's no lighter than `gazetta` and is a second package to keep in step |

Follows from this: in CI and scripts, the client needs an admin to talk to (a hosted one, or `gazetta dev` / `gazetta admin` started for the job). The #49 pass designs the package name, how the client finds a local admin, authentication, and the MCP server's relation to it.

### Q3 — "Can't publish" is enforced on hosted admins; locally, presets and a plain statement

Gazetta enforces it where it can: an agent calling an admin with its own token can't publish. On a developer's machine, the skill ships agent-client permission presets that deny publishing and archive purge, and the docs say local use is trusted like the developer.

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

### Q5 — A public, versioned admin API with an OpenAPI document

The admin API becomes a public, versioned API with an OpenAPI document, for the CLI client, MCP and any script or LLM app. Follows from this: every public route parses its input with its Zod schema, and the OpenAPI document is generated from those schemas.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| Internal OpenAPI, generated from Zod, not promised as public | The maintainer chose a public, versioned API |
| No OpenAPI; CLI commands and MCP tools are the only contracts | No shared contract between the CLI, MCP and the admin |

Its cost: the routes were shaped for the Vue admin, so the #49 pass designs the versioning scheme and which routes form the public surface.

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

## What this changes in the plan

Follows from Q1–Q7.
- ROADMAP's "MCP server design pass" becomes "Agent access design pass" (#49), and "MCP server build" becomes "Agent access build".
- The skill (#1622) is the first step, in Now; the Deferred row for agent instructions goes.
- The #49 pass designs: agent tokens and principals, audit source and run id, per-run undo, the schema check at save, page search, the thin CLI (name, discovery of a local admin, commands, JSON output), API versioning and the public surface, the MCP server over the same client, and the live view (`design-ai-direction.md` Q8).
