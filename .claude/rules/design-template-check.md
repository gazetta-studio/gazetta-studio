# Template check

A check a pull request runs when it changes a template: CI parses the content that uses the changed template against the new schema, fails when the change breaks content, and reports what breaks, grouped by template. Resolves [#1660](https://github.com/gazetta-studio/gazetta-studio/issues/1660).

**Status**: design pass complete (2026-11-01), grilled T1–T12. Implementation not started.

**Companion docs:**
- Discovery research: [#1660](https://github.com/gazetta-studio/gazetta-studio/issues/1660) (discovery-prep-bot comment, 2026-11-01)
- [`design-validation.md`](design-validation.md): `schema-conformance` and its stages; this design changes its `cli` severity (T7)
- [`design-agent-access.md`](design-agent-access.md) Q49: save rejects schema errors only in the components it touches; content a later template change breaks is what this check catches
- [`design-public-storage.md`](design-public-storage.md) Q4: public targets hold no manifests (T11)
- [`design-publish-undo.md`](design-publish-undo.md) Q3: undo refuses content that no longer fits today's template
- [#1169](https://github.com/gazetta-studio/gazetta-studio/issues/1169): migrating content after a schema change, the fixing half (T6)
- Scenario TD3 in [`docs/actor-scenarios.md`](../../docs/actor-scenarios.md): "When does the breakage become visible?"

## Scope

**In v1:**
- `gazetta validate` fails when content doesn't fit its template's schema
- `--base <ref>`: fail only on problems the PR introduced
- `--targets`: check content stored on named targets too
- `--json` and a GitHub output mode: job summary and annotations, grouped by template
- `--render`: opt-in check that changed templates still render the content using them
- A workflow snippet in the docs; this repo's CI runs the check

**Out of v1:**
- Fix suggestions and content migration (#1169, T6)
- A published GitHub Action or PR comment (T4)

**Non-goals:**
- An override for a deliberate breaking change (T3)

## Discovery

Read from code on 2026-11-01:
- `schema-conformance` at the `cli` stage parses every page, fragment and nested component against its template's Zod schema and reports `warn`; `gazetta validate` defaults to `--severity=error`, so broken content prints "All good." and exits 0.
- It walks `site.pages` and `site.fragments` only, so language versions aren't checked ([#1664](https://github.com/gazetta-studio/gazetta-studio/issues/1664)), and a template that exists but fails to load is skipped and reported nowhere ([#1665](https://github.com/gazetta-studio/gazetta-studio/issues/1665)).
- At `pre-publish` it returns nothing, so no gate blocks schema problems today ([#1302](https://github.com/gazetta-studio/gazetta-studio/issues/1302)).
- `template-impact.ts` already lists the items using a template with their issues (the DevPlayground Impact tab); the report can reuse it.
- `gazetta validate` has no machine-readable output.

## Locked decisions

### T1 — A change breaks when existing content no longer fits

CI parses every page and fragment that uses the changed template against its new schema. The PR fails only when existing content no longer fits, and the report names each page, field and language.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Both: the same pass/fail, plus a summary of the schema change | Costs a Zod/JSON-Schema diff of base and head, and `.transform()` or `z.custom()` fields diff as "any" |
| Schema diff only (GraphQL Inspector's model) | Fails PRs that break nothing, and misses content that was already broken |

### T2 — Only what the PR broke fails it

CI checks content against the base branch's templates and the PR's templates, and fails only on problems the base didn't have. Content broken before the PR is listed under "already broken" but doesn't fail it, as save-delta reports only what an edit broke. It costs about twice the run time.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Check only items using a changed template, no base run | A PR touching `hero` fails for an old, unrelated hero problem |
| Fail on any problem anywhere | One old broken page fails every PR until someone fixes it |

### T3 — A deliberate breaking change passes by fixing the content in the PR

No override. The developer updates the affected content in the same PR (the report lists it), and the check turns green.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| An approval label (like GraphQL Inspector's `approved-breaking-change`) | Broken content then reaches Site health and, once #1302 is fixed, the publish gate |
| A workflow flag (`--allow-breaking`, or warn-only) set once by the operator | No per-PR decision; teams that want a gate don't set it |

### T4 — The report is a job summary and annotations

`gazetta validate` gains `--json` and a GitHub output mode: a table grouped by template (pages, fields, languages) in the job summary, and annotations on the changed template files. The docs give a workflow snippet to copy. Gazetta ships no Action of its own.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| A published Action that posts and updates a PR comment | A second release to maintain, and it needs `pull-requests: write` in users' workflows |
| CLI output only | Developers open the job log to see what broke |

### T5 — The check reads the repo's content and named targets' content

The check reads the editing target in git and the content stored on targets.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| The repo's content only | Content edited only on a hosted target, such as a production hotfix, isn't checked in the PR |

### T6 — The report names problems; it suggests no fixes

The report names each page, field, language and the Zod message ("cta: Required"). Fixing stays with #1169.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Mechanical hints per kind of change ("give `cta` a default or fill it on these 4 pages") | A list of rules per kind of Zod change to maintain |
| Design #1169 in the same round | A bigger round, and #1169 is placed in Later |

### T7 — `gazetta validate` fails on schema problems

`schema-conformance` reports errors at the `cli` stage, matching `pre-publish`, so `gazetta validate` exits non-zero when content doesn't fit its template. The PR check is then `gazetta validate --base origin/main`, which adds T2 on top. No production users, so the change costs a changelog line.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Keep `warn`; only the PR mode fails | Local runs keep saying "All good." with broken content |

### T8 — Rendering is checked only with an opt-in flag

`--render`, off by default, also renders the content that uses a changed template and fails when a template throws. Without it the check parses content against schemas and doesn't run templates.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Schema only, render left for later | A template that throws on valid content isn't caught |
| Render always | A render per affected page: minutes at the 5,000-page envelope for a widely used template |

### T9 — Broken content on a target fails the PR; the fix brings it into the PR

Content on a target that the new template rejects fails the PR like repo content. The report says how to fix it ("pages/promo on production doesn't fit the new hero: publish production → local, fix it here"): the developer publishes that content back to local, fixes it in the PR, and it goes out with the next publish.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Target problems are warnings; only repo content fails | Production then holds content its new template rejects, and its next publish fails at the pre-publish gate (once #1302 is fixed) |
| Fail, and fix on the target directly | Works only on editable targets; production is read-only by default |

### T10 — The workflow names the targets to read

`gazetta validate --base origin/main --targets production,staging`. The operator lists the targets and provides their read credentials as CI secrets. A listed target that can't be read fails the check with its name and the error, so a missing secret isn't skipped silently.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Every target whose credentials are present, others skipped with a note | A removed or misnamed secret quietly drops a target from the check |
| Every configured target, always | Every repo's CI needs credentials for every target, including local folders CI doesn't have |

### T11 — Naming a public target fails the check

Public targets hold no manifests (`design-public-storage.md` Q4), so naming one in `--targets` fails the check, and the workflow lists only targets that hold content.

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| Skip it with a note and pass | The maintainer chose the stricter rule |

A target that moves to public storage then breaks CI until the workflow drops it.

### T12 — Build order: gate first

See "Cut sequence".

Decided: maintainer, 2026-11-01 (#<PR>)

| Rejected | Why |
|---|---|
| PR mode (`--base`) first | Its first version only reports in the terminal |
| One cut for the check, then docs and CI | One large review, and nothing usable until all of it lands |

## UX check

Template developers are the main actor (TD3); operators own the workflow (T10); content authors see nothing new.

The report, per T1, T2, T4, T6 and T9, grouped by template:

| Row | Content |
|---|---|
| Template | `hero` (with an annotation on `templates/hero/index.tsx`) |
| Item | `pages/home` (fr), `@promo`, `pages/promo` on production |
| Field and message | `cta: Required` |
| Fix line (target content only) | "publish production → local, fix it here" |
| Already broken (T2) | Listed separately; doesn't fail the PR |

Nothing shows when nothing breaks: the summary says the check passed and how many items it checked.

## Foundational checks

- **Scale:** a Zod parse per component, twice with `--base` (T2): seconds at 5,000 pages from the repo. `--targets` reads every manifest on each named target: about 5,000 reads, 30–60 s on cloud storage, acceptable in CI, which has no admin SLA. `--render` renders only content using a changed template (T8).
- **Locale:** every language version is checked and reported per language (#1664 first).
- **Themes:** none; schemas don't vary by theme.
- **Auth + RBAC:** none; CI runs as the repository, with read credentials for named targets (T10).
- **Audit, Review, Hooks, Cache, Offline, Collaboration:** none.
- **Render:** only with `--render` (T8).
- **Validation:** `schema-conformance` becomes `error` at `cli` (T7); the base comparison is a new orchestration over the existing validators.
- **Plugin:** plugin-contributed validators run in `gazetta validate` as today; only `schema-conformance` takes part in the base comparison.
- **Multi-instance:** a stateless CLI run.

## Cut sequence

[#1664](https://github.com/gazetta-studio/gazetta-studio/issues/1664) (language versions) and [#1665](https://github.com/gazetta-studio/gazetta-studio/issues/1665) (templates that fail to load) land before cut 1.

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `schema-conformance` reports errors at `cli`, so `gazetta validate` fails on schema problems; changelog line (T7) | #1664, #1665 | integration | Low |
| 2 | `--json` and the GitHub output mode: job summary and annotations, grouped by template (T4, T6) | 1 | integration | Medium |
| 3 | `--base <ref>`: base templates loaded from a git worktree; fail only on new problems, list old ones (T2) | 2 | integration | Medium-high |
| 4 | `--targets`: read named targets' manifests; fail on public or unreadable ones; the fix line for target content (T5, T9–T11) | 3 | integration | Medium |
| 5 | `--render`: render content using a changed template, fail on a throw (T8) | 3 | integration | Medium |
| 6 | Docs: the workflow snippet, in `docs/cli.md` and `docs/templates.md` | 4, 5 | docs | Low |
| 7 | This repo's CI runs the check for the starter and gazetta.studio (maintainer PR: workflow file) | 6 | (CI) | Low |

## Migration

No production users. After cut 1, a site whose content doesn't fit its templates fails `gazetta validate` until the content is fixed.

## Open questions

1. How the base comparison matches a problem on base with one on head (item, content path and message, or item and field only) when a schema change rewords Zod's message: cut 3 decides and tests it.

## Future directions

- Fix suggestions and migrations, with [#1169](https://github.com/gazetta-studio/gazetta-studio/issues/1169).
- A PR comment, if job summaries prove too easy to miss.
