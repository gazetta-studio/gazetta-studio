---
name: gz
description: Edit a Gazetta site's content through its admin with the gz command line - pick the admin to work on and check which one gz uses. Use when the person works on a Gazetta site through an admin URL rather than in a Gazetta project folder.
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

## Output and exit codes

Add `--json` to any command for machine-readable output; errors then come on stdout as `{"error": {"kind", "message", "hint"}}`. Exit codes:

- 0: done
- 1: failed
- 2: wrong usage
- 3: login or elevation needed
- 4: conflict: someone else changed it
- 5: not found

`gz` never prompts when it isn't run in a terminal.

## Never do these; ask the person

These publish, delete content, or rewrite a target's history. Don't call them through the admin's API; tell the person what you would do and why, and let them do it.

Admin API routes:
- `POST /api/publish`
- `POST /api/publish/stream`
- `POST /api/fetch`
- `POST /api/history/undo`
- `POST /api/history/restore`
- `DELETE /api/pages/:name`
- `DELETE /api/pages/:name/purge`
- `DELETE /api/fragments/:name`
- `DELETE /api/fragments/:name/purge`
- `DELETE /api/assets/:name`
- `POST /api/assets/:name/replace-with/:newName`

Also never approve a publish or review request on the person's behalf.
