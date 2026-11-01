<!-- gazetta:agents start -->
## Gazetta

This project is a Gazetta site. Before you change anything under `sites/`, `templates/` or `admin/`, install the Gazetta skill if your skills folder doesn't have it yet: copy the folder `node_modules/gazetta/agents/gazetta/` into the folder your agent reads skills from (for example `.claude/skills/gazetta/` for Claude Code, or `.agents/skills/gazetta/` for Codex, Copilot and Cursor). It matches the installed version of Gazetta. Then follow it.

Never run these; ask the person to:
- `gazetta publish`
- `gazetta deploy`
- `gazetta undo`
- `gazetta rollback`
- `gazetta archive purge`
- `gazetta state remove`
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

Never approve a publish or review request on the person's behalf.
<!-- gazetta:agents end -->
