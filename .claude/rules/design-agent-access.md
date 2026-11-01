# Agent access

How AI agents (coding agents, scripts, chat apps) reach Gazetta's content: in what order the ways in ship, how they write, what stops them publishing, and how they learn about changes. This sets the direction for the design pass in [#49](https://github.com/gazetta-studio/gazetta-studio/issues/49), which now covers agent access as a whole, MCP included; each piece below gets its details there.

**Status**: direction decided 2026-10-31, Q1–Q11; agent identity decided 2026-11-01, Q12–Q30; presets Q31; the skill's never-run list, updates and install Q32–Q34. The #49 design pass designs the details.

**Companion docs:**
- [`design-ai-direction.md`](design-ai-direction.md): agents lead Gazetta's AI work; they can't publish by default (they act as the person who signed them in, Q12); the live view of agents' changes (Q8)
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

The thin CLI is a separate, small client that calls a Gazetta admin's API, local (`gazetta dev`) or remote, so the admin is always the writer: saves go through its save path, and the caller's identity is enforced on an admin that authenticates callers (not `trust: 'none'`, the local default; see Q3).

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

The thin CLI has a publish command too, through the API: on a target that needs approval it creates a publish request, where `gazetta publish` refuses. Two commands named publish with different behaviour depart from team rule 7 (one word per concept); the maintainer chose to keep both and record the difference. With it, an agent with publish rights on a hosted admin can publish or request a publish through the same client. Follows from Q12 and Q29: an agent's token publishes only while its person has elevated; without an elevation, the command creates a request on a target that needs approval, and elsewhere starts an elevation and waits for the person's approval.

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

The discovery's outcome is Q12–Q13.

### Q3 — "Can't publish" is enforced on hosted admins; locally, presets and a plain statement

Gazetta enforces it where it can: an agent calling an admin with its own token can't publish. On a developer's machine, the skill ships agent-client permission presets that deny `gazetta publish` and archive purge, and the docs say local use is trusted like the developer. Follows from Q2: the presets must also deny the thin CLI's publish command and publish calls to the API; the #49 pass designs them.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| A local agent principal in config | Anything the agent can run, it can edit, including that config; calling it a guarantee would overstate it |
| Docs only | Presets cost little and stop the common accident |

Amended by Q31 (2026-11-01, #1648): no presets ship; the skill lists what an agent must never run.

### Q4 — The skill ships in the npm package and `gazetta init` adds it

A `SKILL.md` and `AGENTS.md` lines ship in `gazetta`; `gazetta init` copies them into new projects; a test checks that every command the skill names exists. ROADMAP's Deferred row "Agent instructions (skills) for template developers" moves up.

Decided: maintainer, 2026-10-31 (#1623)

| Rejected | Why |
|---|---|
| A separate skills repo and plugin | A second release to keep in step with the CLI |
| `AGENTS.md` lines only, until the MCP server ships | Delays the cheapest, most-adopted piece behind the most uncertain one |

Amended by Q34 (2026-11-01, #1650): `gazetta init` writes only the `AGENTS.md` section, and the agent installs the skill from the package.

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

The thin Go CLI (Q2, Q8) serves people who don't develop templates (content creators), and their agents (Q10). The `gazetta` CLI serves developers.

Decided: maintainer, 2026-10-31 (#1623)

Open for the #49 pass (product owner's note): content creators won't have the `gazetta` npm package, so their agents need another way to get the content part of the skill (Q4), for example from the Go CLI.

### Q10 — Both CLIs are built for people and for agents

Both CLIs are designed to be used by people and by AI agents.

Decided: maintainer, 2026-10-31 (#1623)

What that means in detail is for the #49 pass. A starting point (product owner's proposal, not a decision): readable output by default and JSON output on request, a flag for everything a prompt would ask, and plain error messages. The `gazetta` CLI has no JSON output today.

### Q11 — Both CLIs can return URLs where an AI sees the rendered content

Both CLIs can return URLs that an AI can use to see rendered content.

Decided: maintainer, 2026-10-31 (#1623)

Open for the #49 pass (product owner's note): which URLs (the preview of a page just edited, the page on a target after publish) and, on a hosted admin, how an agent opens preview URLs that sit behind authentication (#1624; it acts with its person's identity, Q12). The maintainer's ideas for that discovery, not decisions (posted on #1624): "to authenticate, user can do that from ui, or we can think of other ways if needed"; "maybe a pincode"; "or gz auth login" (`gz` as a candidate name for the Go CLI).

### Q12 — An agent uses its person's identity; publishing needs an elevation

An agent signs in as the person using it; there is no separate agent identity. Any token used outside the browser (the Go CLI, the API, MCP) can edit at most. Publishing or deleting through such a token needs a short elevation the person approves in the admin (for example `gz elevate`, showing a pin to confirm there). What a CLI publish does without an elevation is Q29. Each save records the way it came in (browser or CLI token) and a run id, so an agent's run can be reviewed and undone. Login codes are approved in the admin (Q19, Q21), except where Q15 says otherwise.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Two identities per person (`alice` and `alice-agent` in the login layer) | A second account per person on every platform; Cloudflare service tokens are refused today |
| The agent as its own principal (`agent:<name>` with an owner) | More to build: an owner link and a new role, for the same "can't publish" guarantee |

This replaces the "own principal" part of `design-ai-direction.md` Q6 and of ROADMAP's starting decision for this pass; "can't publish by default" stays.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Keep agents as their own principal and add elevation for them | More to build; the audit would name the agent directly, but the maintainer chose one identity |

### Q13 — The login layer authenticates; Gazetta identifies the user and issues its own token

On a hosted admin, the platform's login layer (Cloudflare Access, Easy Auth, ALB, Tailscale) authenticates the person; Gazetta identifies the user from it and issues a Gazetta token. Asked how the CLI's requests get past the login layer, the maintainer answered "we use only login layer".

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Exempt `/api` and the pin pages from the login layer, Gazetta checks the token itself | The maintainer chose to use only the login layer |
| Both: exempting by default, sending both credentials as an option | Same reason |
| No Gazetta tokens at all; the CLI sends the platform's credential | The maintainer chose a Gazetta token issued after the login layer identifies the user |

### Q14 — "Agents can't publish" is guaranteed per platform

Research on #1624 (2026-11-01) found that where the CLI's platform credential is the same as the browser's, Gazetta can't tell an agent's request from the person's browser, so an agent could skip Gazetta's edit-only token and publish with the person's full rights: confirmed for Tailscale Serve (the same identity headers on every tailnet request), probable for Cloudflare's `cloudflared access login` (unverified). Each platform is steered to a credential Gazetta can tell apart (Q15), and the docs state per platform where "agents can't publish" is enforced; on Tailscale and with `cloudflared access login`, only the agent's own judgement and the person's own client settings stop it, as on a developer's machine (Q3, Q31).

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| A passkey (WebAuthn) touch for publishing and for approving an elevation | Gazetta would store people's passkeys, a built-in auth piece `design-auth-rbac.md` rules out, with setup for every user |
| Accept the gap and say so | A weaker guarantee than Q3 promises on hosted admins |

### Q15 — The CLI uses a per-platform credential; Gazetta's token travels in its own header

- **Cloudflare Access:** a service token, with Gazetta's token naming the person.
- **Azure Easy Auth:** an Entra device code with a `gz` app registration.
- **AWS ALB:** its JWT rule checks Gazetta's own token; the person pastes a token from the admin into `gz`, since a pin can't work there.
- **Tailscale:** the device's own identity.

Gazetta's token travels in its own `Gazetta-Token` header, not in `Authorization`, except on ALB (below). Research on #1624 found that Easy Auth and Cloudflare's single-header service-token mode read `Authorization`, as does the `GAZETTA_TOKEN` guard (`admin-api/middleware/auth.ts`).

On ALB the token goes in `Authorization: Bearer` instead, because ALB's JWT check reads only that header and needs an RS256 token with a public key set: Gazetta's tokens are RS256-signed (the Q25 secret is the private key) and the admin publishes its public keys for ALB. The legacy `GAZETTA_TOKEN` guard can't be used on ALB.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| No CLI on ALB for now | The maintainer chose an ALB exception |

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Only platforms where a pin works (Cloudflare, Azure, Tailscale); no CLI on ALB until asked | The maintainer chose all four |

### Q16 — Short-lived signed tokens plus a grant record

A signed token lasts about 15 minutes and is renewed from one stored grant per `gz auth login`, in a private `.gazetta/auth/` folder; as a new `.gazetta/` folder it isn't written on public targets (`design-public-storage.md` Q5, Q7). API calls read no storage; deleting the grant ends access within 15 minutes; the signing key is an environment secret shared by all instances.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| A stored record per token | Every API call reads storage (about 30–50 ms on cloud, estimated) |

### Q17 — An elevation lasts a fixed 15 minutes; production needs its own

A fixed 15-minute window (the operator can lower or raise the cap) that doesn't extend when used, so an agent loop can't keep it alive. It covers non-production targets; production needs its own elevation. It's checked on every publish or delete, so ending it early works at once on every instance.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| 2 hours, extended by each use (GitHub sudo mode) | An agent publishing every few minutes keeps it open indefinitely |
| One action | That's the publish request that already exists, with no elevation at all |

### Q18 — Tokens approve or reject publish requests only while elevated

A CLI, API or MCP token can approve or reject a publish request (when its person holds `publish:approve`) only while elevated. Follows from this and `design-review-workflow.md` lock 10: on a target that allows self-approval (`allowSelfPublishApproval`, default `true`), an elevated agent can approve a request it opened; `allowSelfPublishApproval: false` stops it.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Never; approving only from the browser | The maintainer chose to allow it while elevated |
| Like any capability, whenever the person has it | The approval gate would stop nothing an agent does |

### Q19 — Login and elevation codes are approved only from a browser login

The approve page accepts only a person's browser identity from the login layer, never a service token or a Gazetta token. It can't be enforced on Tailscale or with `cloudflared access login` (Q14).

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Any identity of the person | An agent holding the CLI's credentials could approve its own elevation |

### Q20 — Elevation gives publish rights only; it doesn't skip the approval gate

On a target that needs approval, an elevated publish still creates a request, as a person's browser publish does.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Elevation counts as the approval | One approval at the start of 15 minutes would cover anything the agent publishes, unseen |

On a target that allows self-approval, an elevated agent can still approve its own request (Q18); `allowSelfPublishApproval: false` prevents it.

### Q21 — The approve page shows where the code came from

It shows the machine name, IP address and time the login started, and warns "only approve a code you started yourself"; each code works once and expires in 10 minutes. This defends against someone starting a login and sending the person the link.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Also type the code shown in the terminal | One more step on each login |
| No special defence | Open to the attack |

### Q22 — The agent sets the run id; otherwise each command is a run

`gz` accepts a run id (a flag, or a `GZ_RUN` environment variable the agent sets once per task); without one, each `gz` command is its own run. The skill tells agents to set it.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| One run per login session | Runs grow for days and mix unrelated tasks |
| One run per CLI command as the only rule | An agent's task spans many runs, so reviewing or undoing a task means picking each one |

### Q23 — Cloudflare service tokens: shared or per person, the operator chooses

Gazetta accepts any service token the Access policy allows and never identifies anyone by it; Gazetta's token names the person. With a shared token configured, the admin shows it to signed-in people to copy into `gz`.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Both, but Gazetta never displays a service token | The maintainer chose to let the admin show a shared one |

### Q24 — `gz` keeps its grant in the OS keychain

macOS Keychain, Windows Credential Manager or Linux Secret Service; a file readable only by the user where none exists (CI, containers).

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| A file only | Any process running as the user can read it |

### Q25 — The signing key is an environment secret, required on hosted admins

An environment variable (for example `GAZETTA_SIGNING_KEY`), with two keys allowed for rotation; it is the RS256 private key whose public keys the admin publishes for ALB (Q15). A hosted admin with CLI login enabled refuses to start without it; local `gazetta dev` generates one, since it runs as one instance.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Generated and stored in the target's private `.gazetta/auth/` folder | Whoever can read target storage could forge tokens |

### Q26 — Every auth action is audited

Login approved, elevation approved and ended, grant revoked, and refused approvals are new audit actions, recorded on the source like other events.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Elevations only | Logins and revocations would leave no forensic record |

### Q27 — 60 seconds of clock leeway

Tokens and elevations are accepted up to 60 seconds past expiry and from 60 seconds before issue.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| None | An instance whose clock is a few seconds off would reject fresh tokens or end elevations early |

### Q28 — How a remote MCP server signs in is decided in the #49 MCP design

Chat apps (Claude.ai, ChatGPT) sign in to remote MCP servers with OAuth, which none of Q15's CLI credentials fits. MCP comes third (Q1); the CLI and API don't wait for it.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Gazetta acts as the OAuth server now | The `/mcp` endpoint would have to be let through the login layer, against Q13 |
| A local MCP server only | Chat apps without a local MCP (Claude.ai on the web, ChatGPT) couldn't use it |

### Q29 — Publishing without an elevation: wait for one, or create the request

On a target that doesn't need approval, `gz publish` (and delete) without an elevation shows a code and a link, waits up to the code's 10 minutes (Q21) for the person's approval in the admin, then publishes; the elevation then lasts its 15 minutes (Q17). There, `--no-wait` and CI refuse at once with the message. `gz elevate` stays, for elevating ahead of time. On a target that needs approval, an un-elevated publish creates the request directly, without an elevation: the request already waits for a person's approval. This replaces the first version of Q12, under which every un-elevated CLI publish became a publish request.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Start an elevation first on targets that need approval too | Two approvals in a row (the elevation, then the request), unless self-approval is allowed |

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Show the code and exit; run publish again after approving | Two commands every time |
| Refuse with a message ("run `gz elevate` first") | An extra step every time |
| Create a publish request on targets that don't require approval too | Requests on targets that never asked for approval, and `publish:request` for every editing role |

### Q30 — The auth-rbac lock is amended narrowly

Gazetta still never authenticates people: no passwords, no sign-in, no OIDC or SAML; the login layer does that. After the login layer has identified a person, Gazetta may issue its own tokens for the CLI, API and MCP, approved from that person's browser (Q12–Q29). `design-auth-rbac.md` carries the amendment.

Decided: maintainer, 2026-11-01 (#1630)

| Rejected | Why |
|---|---|
| Keep the lock and drop Gazetta tokens | Most of Q12–Q27 (edit-only tokens, elevation) would need redoing |

Research: [follow-up on #1624](https://github.com/gazetta-studio/gazetta-studio/issues/1624#issuecomment-6556747492) (platform sources, token comparisons, where state is stored).

### Q31 — No permission presets; the skill says what an agent must never run

`gazetta init` writes no agent-client permission presets (no deny rules in `.claude/settings.json`, `.codex/rules` or other client files). The skill and the `AGENTS.md` section list the commands and admin routes an agent must never use, such as publishing and archive purge (Q3), and tell it to ask the person instead; the full list is Q32. The skill declares no tool permissions: the Agent Skills standard can't deny anything (`allowed-tools` only pre-approves, and is experimental). So locally, and on Tailscale and with `cloudflared access login` (Q14), only the agent's own judgement and the person's own client settings stop an agent from publishing; the docs say so. This reverses the presets in Q3.

Decided: maintainer, 2026-11-01 (#1648)

| Rejected | Why |
|---|---|
| Deny rules for Claude Code and Codex, the two clients whose project files can enforce them | The maintainer chose no presets |
| Also Cursor | Same; its command matching isn't confirmed either |
| Pre-approve safe commands with `allowed-tools` | Experimental and per client |

When `gazetta init .` finds existing agent files, it never overwrites them: it appends a marked Gazetta section to `AGENTS.md` only if missing (it writes no `SKILL.md`, Q34). Existing projects get updated skills through Q33's command.

Decided: maintainer, 2026-11-01 (#1648)

| Rejected | Why |
|---|---|
| Skip anything that exists and print what to add | A project with its own `AGENTS.md` would have to add the Gazetta section by hand |

Research: [presets on #49](https://github.com/gazetta-studio/gazetta-studio/issues/49#issuecomment-6557871960) (what each client can deny, the commands and routes to list, what others ship).

### Q32 — The never-run list covers everything that changes a target

The skill's "never run, ask the person" list holds every command and admin route that publishes or deploys, deletes content, or rewrites a target's history, plus approving requests. Today that is `gazetta publish`, `deploy`, `undo`, `rollback`, `archive purge` and `state remove`, and the admin routes `/api/publish`, `/api/publish/stream`, `/api/fetch`, `/api/history/undo` and `/api/history/restore`, page and fragment purge, and deleting a page, fragment or asset. Replacing an asset with another (`POST /api/assets/:name/replace-with/:newName`) is on the list, since it ends by deleting the original; removing one language's version of an asset (`DELETE /api/assets/:name/locale-bytes`) is off it, like removing a translation, and undo covers it. Saves, archive, restore from archive, rename and uploads stay off the list: they are the edits an agent is there to make, and undo covers them. A test fails when a command or route that matches this rule isn't on the list, or when the list names one that doesn't exist. `gz` commands (publish, delete, elevate, approving requests) join the list, and the test, when the Go CLI ships, checked against its own command list.

Decided: maintainer, 2026-11-01 (#1649)

| Rejected | Why |
|---|---|
| Publishing and deleting only | An agent could undo a publish or wipe a target's history without asking |

What counts, and when `gz` joins: Decided: maintainer, 2026-11-01 (#1649)

| Rejected | Why |
|---|---|
| Only what reaches visitors | Deleting pages or assets would be left to the agent |
| List the planned `gz` commands now and skip them in the test | The list would name commands that don't exist yet |

### Q33 — A command refreshes the skill in an existing project

A command (named in the #49 pass, for example `gazetta agents update`) rewrites the files Gazetta owns: `SKILL.md` and the marked `AGENTS.md` section, never the person's other text. `gazetta dev` prints a one-line hint when the installed skill is older than the package.

Amended by Q34 (2026-11-01, #1650): Gazetta no longer writes `SKILL.md`, so the command rewrites only the marked `AGENTS.md` section from the package. The section carries the package version and tells the agent to reinstall the skill from `node_modules/gazetta/agents/` when its installed copy is older; Gazetta never touches files in client folders. Follows from this: `gazetta dev`'s hint compares the `AGENTS.md` section's version with the package, since Gazetta can't see the agent's copy.

Decided: maintainer, 2026-11-01 (#1650)

| Rejected | Why |
|---|---|
| Also rewrite any Gazetta `SKILL.md` found in known client folders | Gazetta would write into client folders after all |

Decided: maintainer, 2026-11-01 (#1649)

| Rejected | Why |
|---|---|
| A short `SKILL.md` that points the agent to the full skill in `node_modules/gazetta` | Agents that don't follow the pointer get only the stub |
| Manual: delete `SKILL.md` and rerun `gazetta init .` | Every project relies on people reading the release notes |

### Q34 — The agent installs the skill from the package

No single folder reaches every coding agent (Claude Code reads `.claude/skills/`, Codex `.agents/skills/`, Copilot and Cursor either; checked against their docs 2026-11-01). So `gazetta init` writes only the marked `AGENTS.md` section, which tells the agent to install the Gazetta skill from `node_modules/gazetta/agents/` into its own skills folder. Each agent puts it where its client reads it, the version always matches the installed package, and it works offline. Until Q33's refresh command ships, existing projects copy the `AGENTS.md` section from the package; the docs say how.

Decided: maintainer, 2026-11-01 (#1650)

| Rejected | Why |
|---|---|
| The same `SKILL.md` in both `.claude/skills/` and `.agents/skills/` | The maintainer chose to let the agent install it |
| Only `.agents/skills/` | Claude Code misses the skill |
| Only `.claude/skills/` | Codex misses it |
| The agent fetches the skill from GitHub | Needs network |
| Let `gazetta init .` add the agent files to an existing project | Reverses its refusal and overlaps Q33's command |
| Build Q33's command now | Widens #1622 |

## What this changes in the plan

Follows from Q1–Q34.
- ROADMAP's "MCP server design pass" becomes "Agent access design pass" (#49), and "MCP server build" becomes "Agent access build".
- The skill (#1622) is the first step, in Now; the Deferred row for agent instructions goes.
- The #49 pass designs: the agent token and elevation flow (Q12–Q30), the remote MCP server's sign-in (Q28), the skill refresh command's name (Q33), audit source and run id, per-run undo, the schema check at save, page search, the thin CLI for content creators (name, discovery of a local admin, commands, output for people and agents, how its users' agents get the skill, release and distribution), output for people and agents in the `gazetta` CLI, the rendered-content URLs both CLIs return, the public API contract, its versioning and v1 cut-off, the bulk save, the MCP server and its relation to the thin CLI, and the live view (`design-ai-direction.md` Q8).
