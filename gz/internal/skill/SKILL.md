---
name: gz
description: Edit a Gazetta site's content through its admin with the gz command line - read, change and create pages and fragments, check them, and pick the admin to work on. Use when the person works on a Gazetta site through an admin URL rather than in a Gazetta project folder.
metadata:
  gz-version: "{{version}}"
---

# gz

Gazetta is a CMS that builds websites from components. A **page** is a route plus a list of components; a **fragment** is a component shared between pages (a header, a footer); each component has a **template** that decides which fields its content has. `gz` works with a site through its Gazetta admin, as the person who signed it in.

The person you work for decides what goes live. You edit and check content; publishing and deleting are theirs (see the last section).

## Choosing the admin

`gz` keeps one profile per admin, and one profile is the default.

- `gz auth list` lists the profiles and marks the default.
- `gz auth use <name>` makes a profile the default.
- `gz auth status` says which admin `gz` will use. With no profile it exits 3 and says how to log in.
- `gz auth logout <name>` removes a profile and its stored login.
- `--admin <name|url>` or the `GZ_ADMIN` environment variable picks another admin for one command.

## One task, one run

Set `GZ_RUN` once per task, to a short id of your own (letters, digits, `.`, `_`, `-`): `export GZ_RUN=fix-footer-links`. Every save then joins that run, so the person can review your task's changes together and undo them as one. Without it, each `gz` command is its own run; `--run <id>` sets it for one command.

To undo a run, `gz runs show <run-id>` lists its items and what reverting would do, and `gz runs revert <run-id>` puts each item back to its version before the run and archives what the run created. Items someone changed since are skipped; name them with `--force <item>,...` only after the person agrees. It exits 4 when an item was skipped because someone changed it, 1 when another item was skipped, and 0 only when everything was reverted or archived. The revert is a run of its own, so it can be reverted too.

## Editing content

- `gz pages list` and `gz fragments list` show names, routes, templates and languages.
- `gz pages get <name> [--locale fr]` prints the manifest. With `--json` it also gives the save-version (`etag`).
- `gz templates schema <template>` prints a template's fields: read it before changing content.
- `gz pages set <name> <path>=<value>...` changes values and saves. A path is dot-separated; inside `components`, address a component by its name: `gz pages set home components.hero.content.title="Spring sale"`. Use `path:=<json>` for numbers, booleans, lists and objects, and `@file` to read a value from a file (`content.body=@body.md`).
- Several items in one command (`gz pages set home ... about ...`, or `--from <folder|file>` with whole manifests, such as `home.fr.json`) are saved all or nothing.
- `gz pages edit <name>` replaces the manifest with JSON from stdin.
- `gz pages create <name> --template <t>` creates a page; with `--locale fr`, a French version of a page that exists.
- The same commands work for fragments, such as `gz fragments set header content.tagline="New"`.
- A save that conflicts with someone else's change exits 4: read the item again and redo your change. A save the template's schema refuses exits 1 and names the fields.

## Checking your work

- `gz validate` lists the site's validation issues and exits 1 if any is an error.
- `gz preview <page> [--locale fr] --html` prints the page as rendered, so you can check it; without `--html` it prints the preview URL for the person (`gz preview @<fragment>` for a fragment).
- `gz status` lists the changes not yet published to the next target. Publishing them is the person's decision.

## Output and exit codes

Add `--json` to any command for machine-readable output; errors then come on stdout as `{"error": {"kind", "message", "hint"}}`. Exit codes:

- 0: done
- 1: failed
- 2: wrong usage
- 3: login or elevation needed
- 4: conflict: someone else changed it
- 5: not found

`gz` never prompts when it isn't run in a terminal.

## Never run these; ask the person

These publish, delete content, or rewrite a target's history. Don't run them or call them through the admin's API; tell the person what you would do and why, and let them do it.

Commands:
- `gz publish`
- `gz elevate`

Admin API routes:
- `POST /api/v1/publish`
- `POST /api/v1/publish/stream`
- `POST /api/v1/fetch`
- `POST /api/v1/history/undo`
- `POST /api/v1/history/restore`
- `DELETE /api/v1/pages/:name`
- `DELETE /api/v1/pages/:name/purge`
- `DELETE /api/v1/fragments/:name`
- `DELETE /api/v1/fragments/:name/purge`
- `DELETE /api/v1/assets/:name`
- `POST /api/v1/assets/:name/replace-with/:newName`
- `POST /api/v1/auth/logins/:code/approve`
- `POST /api/v1/auth/logins/:code/deny`
- `POST /api/v1/auth/grants`
- `POST /api/v1/review/page/:name/approve`
- `POST /api/v1/review/page/:name/reject`
- `POST /api/v1/review/fragment/:name/approve`
- `POST /api/v1/review/fragment/:name/reject`

Also never approve or deny a login, elevation, publish or review request on the person's behalf. Saving, creating, uploading assets and setting alt text are fine: the person can undo them.
