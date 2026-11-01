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
