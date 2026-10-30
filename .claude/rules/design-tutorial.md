# Tutorial

The Stage 1 tutorial: one path a newcomer follows from `npx gazetta init` to undoing a publish on a second target, kept true by a CI check that runs its commands word for word. Also how today's `docs/getting-started.md` splits into the tutorial and six other pages.

**Status**: design pass complete (2026-10-24), grilled Q1–Q17 (Q14–Q17 added after review); the tester protocol (Q12) settled in Q18–Q28 on 2026-10-30. Cuts 1–6 landed; cut 7 is #1543.

**Companion docs:**
- [`docs/audits/website-and-channels.md`](../../docs/audits/website-and-channels.md): the website plan. Stage 1 opens when "a release on npm matches the docs; the tutorial passes in CI; 3–5 people the maintainer watches get from install to a publish on a second target without help"
- [#1272](https://github.com/gazetta-studio/gazetta-studio/issues/1272): the docs pipeline. It builds gazetta.studio's docs from `docs/`, fails on raw HTML outside code, and ties `docs-nav.json` and AGENTS.md's "Public docs" list to the file list
- [`design-publish-undo.md`](design-publish-undo.md): undoing a publish on a destination, which the tutorial's last step needs ([#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092))
- [#1284](https://github.com/gazetta-studio/gazetta-studio/issues/1284): `gazetta init` adds a filesystem `staging` target, the tutorial's second target
- [`docs/actor-scenarios.md`](../../docs/actor-scenarios.md): the tutorial walks the Content Author's path (CA1) on a site a Template Developer just created
- Research: a getting-started audit (53 findings, filed as #1300, #1304–#1306, #1309–#1318 and additions to #1284) and a research round on comparable tutorials, CI prior art and first-use sessions (2026-10-24)

## Scope

**In v1:**
- An 8-step tutorial at `/docs` (`docs/getting-started.md`), no accounts
- A Playwright spec that runs the tutorial's commands against a local registry, and fails when the tutorial's commands and its own step list differ
- A `tutorial` CI job, and a weekly and after-release run against npm
- Six new docs pages taking over the rest of today's getting-started
- A release candidate on npm for testers (Q7)

**Out of v1:**
- A "How Gazetta works" explanation page (Q11)
- A stated time to complete, until it's measured (Q11)

**Non-goals:**
- Teaching templates, configuration, cloud targets, deploy or the CLI in the tutorial. They're in the guides; Diátaxis keeps choices and alternatives out of tutorials.

## Discovery

- None of nine comparable first-run docs teaches undo (Astro, Payload, Strapi, Directus, Keystatic, TinaCMS, Hono, Django, Rails). Directus's Environment Sync quickstart, which runs two local instances, is the closest to `local` → `staging`.
- Undoing a save on `local` works today (the save toast's Undo, the History panel). On a publish destination, undo restores manifests only, so the served page doesn't change (#1084): publish undo cuts 1, 2, 4 and 5 remain (#1092), and cut 4 waits on review-workflow cuts #526 and #527.
- `main` and npm are both at 0.8.0, so a scaffold that depends on `^0.8.0` (or `*` today) installs npm's copy, not the code under test.
- `gazetta dev`, `serve` and `admin` all default to port 3000 (`cli/index.ts:2493-2505`).
- CI already packs a tarball (`pack`) and smoke-tests it (`smoke`, `scripts/smoke-publish.sh`), and `tests/e2e/scenarios/edit-publish-sync.spec.ts` covers edit, save and publish to staging. Bots can't edit `.github/workflows/**` (#840).
- #1282 releases to npm only after the whole Stage 1 gate.

## Locked decisions

### Q1: The tutorial ends by undoing a publish; tester round 1 runs before that works

The last step undoes the publish to staging, and the reader sees staging's old title come back. Stage 1 still opens only once that works, but tester round 1 runs before it, on install to publish; only round 2 waits for #1092.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Undo the save on local | Ending: edit, save, click Undo in the save toast, and the old title is back in the preview. Works today, so Stage 1 doesn't wait for #1092; staging undo is added when it ships. Shows history, but not on a publish destination |
| Undo the publish; wait | As the plan says: the tutorial and all tester rounds wait until undoing a publish on staging works |
| No undo in the tutorial | End at the publish to staging; undo goes to the publishing guide. Stage 1 doesn't wait for #1092 |

### Q2: Publish the untouched site first

The reader publishes the untouched site to staging and looks at it, edits the hero and saves, publishes again, and Undo brings back the title they saw on staging. One edit.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Edit, publish, edit, publish | Two edits and two publishes; Undo returns to the first edit. Longer |
| Edit, publish, undo | One publish; Undo empties staging, since there was nothing before it |

### Q3: Publish and undo happen in the admin

The Publish panel and its Undo button: the content author's path. The CLI commands (`gazetta publish staging`, `gazetta undo staging`) go in the publishing guide.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| In the terminal | `npx gazetta publish staging` and `npx gazetta undo staging`. Simpler to test, but the reader leaves the admin for the key steps |
| Admin, with CLI asides | The admin steps, each with a one-line "or run …" for the terminal |

### Q4: Staging is viewed from a second terminal on port 3001

`gazetta dev` keeps running; in a second terminal the reader runs `npx gazetta serve staging --port 3001` and opens localhost:3001. Needed because undo happens in the admin while staging is viewed. This answers #1284's open point about the port clash.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Stop dev, serve, restart dev | One terminal: stop `dev`, run `serve staging`, look, stop it, start `dev` again. Two extra steps, and the admin goes away meanwhile |
| Change the product | `serve` or `dev` picks a free port when 3000 is taken. A code change outside the tutorial |

### Q5: CI installs from a local registry

CI starts a Verdaccio registry holding the freshly packed tarball, with `gazetta` not fetched from npm, so the docs' commands run word for word and get the new code. A check confirms the installed package is the tarball. No product change (Storybook's pattern).

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Test hook in init | `gazetta init` gets a test-only option to install a given tarball (Next.js's pattern). Changes init and the first command CI runs |
| Unique prerelease version | Bump to a throwaway prerelease before publishing to the local registry. Adds versioning steps |

### Q6: The test owns a step list

A Playwright spec holds each step's command and checks, and fails when the tutorial's shell blocks differ from its list in text, order or count. Editing either without the other fails CI. No markers in the Markdown, so nothing collides with #1272's raw-HTML rule.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Annotated Markdown | A runner reads markers in the Markdown (fence attributes like ```` ```bash tutorial=init ````). Needs #1272's highlighter to accept them |
| Doc Detective | An existing docs-testing tool drives the steps. Another dependency; worth it only if the browser part grows |

### Q7: Testers install a release candidate

A one-off `rc` release on npm (`npx gazetta@rc init`), approved by the maintainer; `latest` stays 0.8.0. The closest to what users will run. #1282 rejected publishing every merge as `next`, not a single release candidate; this refines the website plan's "next release after the whole Stage 1 gate" (see Q16, Q17 for what it needs).

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| A CI tarball | Testers get a file from CI and run `npx --package=<file> gazetta init`. No npm release, but not the real install |
| Release first | Publish a normal release before testing. Reverses #1282's "after the whole Stage 1 gate" |

### Q8: A new `tutorial` CI job

A `tutorial` job in `ci.yml` after `pack`, on every PR and push to main, Ubuntu only, about 3–4 minutes; plus a weekly and after-release run against npm. The maintainer adds the job once in a PR; the spec, registry config and checks are fleet work.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Inside the smoke script | Extend `scripts/smoke-publish.sh`, which CI already runs, so no workflow edit. No cached Playwright browsers, so slower and harder to drive the admin steps |

### Q9: Six new pages, in phases

`templates.md`, `pages-and-fragments.md`, `customize-editor.md` and `targets.md` first: they move existing text, fixing that text's audit findings. Then `publishing.md` (publish, undo, history) and `cli.md` (every command and flag), which are mostly new writing. After #1272 merges; one page per PR.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Four pages | Only the pages that move existing text: templates, pages and fragments, customizing the editor, targets. No CLI reference or publishing guide |
| Tutorial plus one guide | The tutorial, and everything else in one "Guide" page. Keeps the mix of how-to and reference the audit found |

### Q10: Placement in #1272's groups

`publishing.md` in Start, after the tutorial; `targets.md` first in Deploy; `templates.md`, `pages-and-fragments.md` and `customize-editor.md` in Content and templates; `cli.md` in Admin and operations. No new group.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Add a Reference group | A fifth group for cli.md and targets.md. Reopens #1272's four-group decision for two pages |

### Q11: Five defaults

(a) No stated time until measured, then the testers' median rounded up. (b) CI runs it on every PR and push to main, plus weekly and after each release against npm. (c) The undo step is marked as an expected failure until #1092 lands, so CI shows the day it starts working. (d) The split lands after #1272 merges. (e) A "How Gazetta works" explanation page comes later; the tutorial's opening and recap carry it for Stage 1.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Go through them | I'll ask each one separately with its alternatives |

### Q12: The tester protocol is settled before round 1

A short round of its own, once the tutorial's preconditions (#1284, #1300, #1304 and the rest) are close: whether undo counts, AI assistants, live or recorded sessions, the pass rule, recruiting, an incentive, recording, retention, legal basis, whose machine, the starting page, publishing results. Tester round 1 can't start before it.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Now | Go through all 12 in this design round |

### Q14: The tutorial adds an image

The reader picks an image for the hero and sees it on staging. The asset picker (#1345) and serving published assets (#1330) become Stage 1 gate items, and so does #1249 (follows from Q14: the tutorial's staging is served by static `gazetta serve`, which corrupts binary files until #1249), and the tutorial gets a step longer.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| No, but gate on images | The tutorial stays seven steps with no image. The Stage 1 gate adds "an image added in the admin shows on a published target", so the picker (#1345) and asset serving (#1330) get the priority label |
| No image, no gate change | Media is fixed on its own schedule; Stage 1 can open with images broken on published sites |

### Q15: The npm run starts with the first release candidate

The weekly and after-release run targets `gazetta@rc` while an rc exists, then `latest` after the release; before the first rc it doesn't run. The per-PR run against the local registry covers main meanwhile.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| From the release | The npm run starts only once a normal release contains the tutorial |

### Q16: The release candidate waits for #1281

Tester round 1 and the rc wait for #1281 (`gazetta init` depends on `^` its own version), so `npx gazetta@rc init` installs the rc: with `"gazetta": "*"`, npm resolves to `latest`, never a prerelease.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Leave as is | Testers would run 0.8.0 after init; the round would test the old release |

### Q17: The publish workflow passes `--tag` for prereleases

`publish.yml` publishes a prerelease version (`0.9.0-rc.1`) with `--tag rc`, keeping provenance; a maintainer workflow PR, before the rc. Normal versions still go to `latest`.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Publish the rc by hand | You run `npm publish --tag rc` locally for the one rc, without provenance; no workflow change |

## Tester protocol

The protocol round Q12 asked for, run on 2026-10-30. Q1 already settled whether undo counts: round 1 runs without it, and round 2, once #1092 lands, includes it (cut 10). The options came from a draft protocol written on 2026-10-24 from usability-testing guidance (NN/g, GOV.UK Service Manual, MeasuringU, Krug); the draft itself isn't in the repo.

### Q18: Testers may use AI assistants, and finishing with one counts

Testers use their usual tools, AI coding assistants included. Each session records which assistant was used, and AI users are reported separately: if only AI users finish a step, that's a problem to fix. "Without help" in the gate means without the maintainer's help, not without the tester's own tools.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| Allowed, not counted | Testers may use AI, but a session that used it doesn't count towards the gate. Needs more testers to get 3 sessions that count |
| Not allowed | Testers are asked not to use AI. It tests the docs alone, but not how many people actually try a new tool today |

### Q19: A round passes when every tester gets through

A round of at least 3 new testers passes when every tester gets through install, editing with an image, and publishing to staging without the maintainer's help, and no problem rated major or catastrophe is left open. In round 2, undo counts too (Q1). Severity levels: Q28.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| 3 of 5 | A round of 5 passes when at least 3 finish without help. Tolerates one bad session, but lets a step that loses 2 in 5 people through |
| Problems only, no rule | No pass/fail: you read the findings and decide. Flexible, but the gate stays subjective |

### Q20: Sessions are live and remote, on the tester's own machine

The maintainer watches over a screen share while the tester works on their own computer, OS, shell and Node, thinking aloud. About 60 minutes, plus a 15-minute tech check the day before. The maintainer only prompts neutrally; any hint is logged as an assist.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| Unmoderated recording | The tester records themselves following written tasks, and you watch later. Easier to schedule, but nobody can ask what they expected, and stuck testers just stop |
| In person, your machine | Same room, a prepared laptop. Easiest to observe, but it hides problems with their own setup (Node version, shell, OS), which is what install testing should find |

### Q21: Testers start on the gazetta.studio home page

The tester's browser opens on the gazetta.studio home page, with an empty folder in their terminal. The tasks state goals, not commands, so the site, README and docs are tested too, as a real newcomer meets them.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| The tutorial page | They start on /docs. Tests the tutorial itself more directly, but skips how people find it from the home page |
| The GitHub README | They start on the repo. Matches people arriving from GitHub, but Stage 1's path runs through the site |

### Q22: Testers are second-degree contacts, screened

Testers build websites, use a terminal and npm, and have never seen Gazetta. They're found through friends of friends, a local meetup or a developer community the maintainer belongs to, and a 5-question screener filters them. Excluded: the October contributors, close friends, colleagues, and people who build CMSes. No public post, since Stage 1 opens no channels. One stand-by per round.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| Your own network | Colleagues and friends who fit the profile. Quickest, but they're likely to be kinder and to know your habits, so problems hide |
| Public call | A post asking for testers. Reaches strangers, but it's a public channel before Stage 1 opens |

### Q23: No incentive

Testers volunteer; nothing is paid or donated. Free, but harder to recruit strangers and more no-shows.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| Gift card, paid at start | A gift card worth about an hour of a developer's time (for example €50), given at the start of the session so it doesn't depend on finishing (GOV.UK's advice). The exact amount is yours to set |
| Donation in their name | The same amount to a charity or open-source project they choose. Some developers prefer it; costs the same |

### Q24: Recorded with consent, kept private, deleted within 30 days

The tester agrees before recording, out loud or in writing, after hearing who watches, what is recorded, where it's kept, and that they can stop and have it deleted. The maintainer keeps a record of each consent; consent is the legal basis. Recordings and notes stay on the maintainer's machine, never on GitHub, and are deleted once the round's issues are filed, at the latest 30 days after the session. Claude may help analyse anonymised notes, and the consent says so. What testers are told about public reporting: Q27.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| Same, but no AI on notes | As above, but notes are analysed by you only. Simpler consent, more of your time |
| Notes only, no recording | No screen or audio recording, only your live notes. Least sensitive data, but you can't re-check what someone did or the exact error text |

### Q25: Each round publishes issues and a findings note

One GitHub issue per problem rated minor or worse, quoting what happened without names. One findings note per round in `docs/audits/`, with problems, counts such as "2 of 3", ratings and what changed. Testers appear as P1, P2, with no names, employers or screenshots. Security problems and further redaction: Q26, Q27.

Decided: maintainer, 2026-10-30 (#1585)

| Rejected | Shown to the maintainer as |
|---|---|
| Issues only | Each problem becomes an anonymised issue; the round summary stays private |
| Nothing public | Findings stay private and you fix them. Less exposure, but contributors can't see why changes were made |

### Q26: Security problems found in a session are reported privately

A problem that is a security vulnerability is reported privately, as `SECURITY.md` describes, not as a public issue, and the findings note mentions it only once it's fixed and disclosed. Everything else stays as Q25 says.

Decided: maintainer, 2026-10-30 (#1587)

| Rejected | Shown to the maintainer as |
|---|---|
| Keep Q25 as it is | Every problem becomes a public issue. Simplest, but a security problem found in a session would be public with its reproduction steps before a fix |

### Q27: Testers are told about public reporting, and more is redacted

The consent (Q24) also says anonymised findings and short quotes are published. Before publishing, anything that could identify a tester (their project, company names in paths, usernames in terminal output, unusual details) is removed or reworded, not only names, employers and screenshots.

Decided: maintainer, 2026-10-30 (#1587)

| Rejected | Shown to the maintainer as |
|---|---|
| Tell them only | Add public reporting to what the tester agrees to; keep Q25's list of what's removed as it is |
| Keep as decided | No change. Quotes and details can appear in public with only names, employers and screenshots removed, without the tester being told beforehand |

### Q28: Problems are rated on Nielsen's 0–4 scale

0 not a problem, 1 cosmetic, 2 minor, 3 major (important to fix, high priority), 4 catastrophe (must be fixed before release). Each problem is rated on how often it happens, how badly it blocks the tester, and whether they can get past it. The maintainer rates; Claude sessions may rate the anonymised notes independently as a cross-check. Q19's gate and Q25's issues use these levels.

Decided: maintainer, 2026-10-30 (#1587)

| Rejected | Shown to the maintainer as |
|---|---|
| Our own wording | Define the levels by what happens in the session: minor = the tester noticed and carried on; major = they needed more than a few minutes or a wrong turn to get past; catastrophe = they couldn't continue without help |
| Leave undefined | The maintainer rates each problem by judgement; no written criteria |

## UX check

Follows from Q1–Q4 and Q14. Rule 23: the reader does one thing per step and sees its effect; nothing is explained before it's needed.

| # | Step | What the reader does and sees |
|---|---|---|
| — | Opening | What Gazetta is in one sentence; what they'll do (create a site, edit it in the admin, publish it to a second target, undo the publish); Node 22.22.2+ or 24.15+ (#1304); no accounts |
| 1 | Create a site | `npx gazetta init my-site`, `cd my-site`. `init` installs dependencies itself. One line on what was created: a home page, a header, templates, and two targets, `local` and `staging` |
| 2 | Start the dev server | `npx gazetta dev`; open localhost:3000, then localhost:3000/admin. Leave it running |
| 3 | Publish to staging | In the admin: Publish → staging → Publish. The first publish copies the whole site |
| 4 | Look at staging as a visitor | Second terminal: `npx gazetta serve staging --port 3001`; open localhost:3001 |
| 5 | Edit the home page | Open Home, select the hero, change its title, Save. localhost:3000 shows it; localhost:3001 doesn't: staging changes only when you publish |
| 6 | Add an image (Q14) | On the same hero, pick an image (upload one in the picker) and Save; localhost:3000 shows it, localhost:3001 doesn't |
| 7 | Publish the change | Publish → staging again; reload localhost:3001: the new title and the image |
| 8 | Undo the publish | Click Undo in the publish result; reload localhost:3001 and the old title is back. The edit is still in the admin: undo changed staging, not `local` |
| — | What you did | A target holds the whole site; Publish copies content between targets; each target keeps its own history |
| — | Next steps | "Put it online" (cloudflare.md, self-hosted.md), then templates, customizing the editor, targets |
| — | If something goes wrong | Unsupported Node (#1304), `init`'s npm install failed (#1300), port in use (#1184), Ctrl+C stops a server |

About 900–1,100 words. Shell blocks: steps 1 (init, cd), 2 (dev) and 4 (serve); the troubleshooting section has none, or the spec's step list covers them too. At least one highlighted code block, which `deploy-site.yml`'s check on `/docs` needs.

## The CI check

Follows from Q5, Q6, Q8 and Q11.

1. The `tutorial` job downloads `pack`'s tarball and starts Verdaccio with a config whose `gazetta` rule has no proxy; everything else proxies npmjs.
2. It publishes the tarball under its own version, points npm at Verdaccio (`npm_config_registry`, an empty `npm_config_cache`) and works in a temp directory outside the repo, so `init`'s own `npm install` gets the tarball.
3. `tests/tutorial/getting-started.spec.ts` (its own Playwright config) holds the step table: command, background or not, ready URL, checks. Its first test reads `docs/getting-started.md`, extracts the fenced shell blocks in order and fails if they differ from the table. Steps 1–7 are `test.step`s of one test, named after their headings; the servers are started once for the file, so later tests reuse them. Step 8 (undo) is a separate test in the same serial group, after it. Admin steps reuse `tests/e2e/pages/*`.
4. Checks: init exits 0 without "npm install failed" and writes `local` and `staging`; the lockfile integrity matches the tarball; `dev` answers on 127.0.0.1:3000 and `/admin`; the publish result shows success; `serve` on 3001 shows the old title after the edit and the new one after the publish, and the image answers 200 from localhost:3001 then (Q14); undo brings the old one back. Until #1092 lands, only step 8's own test is marked `test.fail()` (linked to #1092): Playwright applies `test.fail()` to a whole test, so marking a test that also held steps 1–7 would hide their failures; both servers still running at teardown.
5. The weekly and after-release run uses the same spec with no Verdaccio, installing from npmjs and reading the tutorial from the release tag: the check that a release on npm matches the docs. It targets `gazetta@rc` while an rc exists, then `latest`, and doesn't run before the first rc (Q15).

## Foundational checks

Docs and CI, no product surface: multi-instance, scale, themes, auth, audit, review, hooks, render, validation, plugin, cache, offline and collaboration are N/A. Locale: the tutorial is English, like the docs. The docs pipeline (#1272) is the one constraint: no raw HTML outside code, every page classified in `docs-nav.json` and listed in AGENTS.md.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `targets.md`: target types, storage factories with every required key and peer-dependency install, `type`, `environment`, `editable`, `publicStorage`, `history`, `siteUrl`, `cache` (dynamic targets only), secrets and `.env`, relative paths | #1272 | docs | Low |
| 2 | `templates.md`: the template contract, `head`, frameworks, composites | #1272 | docs | Low |
| 3 | `pages-and-fragments.md`: `page.json`, routes, dynamic routes, fragments, the 404 page, translations, layout | #1272 | docs | Low |
| 4 | `customize-editor.md`: custom editors, custom fields, `admin/theme.css` | #1272 | docs | Low |
| 5 | `publishing.md`: publishing from the admin and the CLI, the sync chip and dots, production confirmation, undo, rollback and history | #1272 | docs | Low |
| 6 | `cli.md`: every command, argument and flag, default ports and `--host`, auto-detection, CI behaviour, exit codes | #1272 | docs | Low |
| 7 | The tutorial: `docs/getting-started.md` rewritten as the UX table above; the spec, the Verdaccio config, the integrity check and an npm script that runs them | 1–4, #1284, #1300, #1304, #1345, #1330, #1249 | e2e-first | Medium |
| 8 | The `tutorial` CI job, and the weekly and after-release run (maintainer PR: workflow files) | 7 | (CI) | Low |
| 9 | Tester round 1 on a release candidate (Q7, Q12); before it, `publish.yml` passes `--tag rc` for prereleases (Q17, maintainer PR) | 7, 8, the tester protocol (Q18–Q28), #1281 (Q16) | (manual) | Medium |
| 10 | When #1092 lands: remove `test.fail()` from the undo step; tester round 2 includes undo | 9, #1092 | e2e | Low |

Cuts 1–7 go to feature-bot through a planner issue. The tutorial waits for pages 1–4 so the text it drops already has a home.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Tutorial first | Rewrite the tutorial (cut 7) right after #1272 and the preconditions, moving the other text to a temporary "More" page until pages 1-6 land. Reaches the CI check sooner; the temporary page is extra churn |

Each page cut moves its text out of getting-started and fixes that text's open audit findings (#1310–#1312 may have fixed some in place first), with its `docs-nav.json` entry, AGENTS.md line and generated page in the same PR, as #1272's check requires.

## Migration

None: no production users. Links to getting-started's sections: none today (README.md:138 describes the page; it changes with cut 7).

## Open questions

1. Whether `smoke`'s Ubuntu leg can be dropped once the tutorial job is stable.

## Future directions

- A "How Gazetta works" explanation page (Q11).
- A StackBlitz button that opens an `init`-made site, after the release (research of 2026-10-24: the released 0.8.0 runs there).
