<!-- gazetta:agents start version={{version}} -->
## Gazetta

This project is a Gazetta site, and this section is for Gazetta {{version}}. Before you change anything under `sites/`, `templates/` or `admin/`, make sure the Gazetta skill is installed: copy the folder `node_modules/gazetta/agents/gazetta/` into the folder your agent reads skills from (for example `.claude/skills/gazetta/` for Claude Code, or `.agents/skills/gazetta/` for Codex, Copilot and Cursor). Copy it again, replacing the old one, when your installed copy's `gazetta-version` is older than {{version}}. Then follow it.

Never run these; ask the person to:
- `gazetta publish`
- `gazetta deploy`
- `gazetta undo`
- `gazetta rollback`
- `gazetta archive purge`
- `gazetta state remove`
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

Never approve a publish or review request on the person's behalf.
<!-- gazetta:agents end -->
