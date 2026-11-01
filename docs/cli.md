# Command line

Every `gazetta` command, its arguments and flags, and how the CLI picks a site and a target. Run commands with `npx gazetta <command>` from the project, or through the `dev` script `gazetta init` adds to `package.json`. `npx gazetta help` (also `--help` or `-h`, or no command at all) prints a short version of this page.

## Commands at a glance

| Command | What it does |
|---|---|
| `gazetta init [dir]` | Create a new project and install its dependencies |
| `gazetta dev [site]` | Run the site and the admin at `http://localhost:3000` |
| `gazetta publish [target] [site]` | Render the site and write it to a target |
| `gazetta serve [target] [site]` | Serve a target's published pages |
| `gazetta build [site]` | Build the admin for `gazetta admin` |
| `gazetta admin [site]` | Run the built admin without the dev server |
| `gazetta deploy [target] [site]` | Run the target's deploy adapter |
| `gazetta validate [site]` | Check the site for broken references and other problems |
| `gazetta translate <item> --to <locale> [target]` | Copy a page or fragment as a new language version |
| `gazetta history [target] [site]` | List a target's revisions |
| `gazetta undo [target] [site]` | Restore the revision before the latest one |
| `gazetta rollback <rev> [target] [site]` | Restore a chosen revision |
| `gazetta assets <list\|info\|reindex> ...` | Inspect assets and rebuild dependency indices |
| `gazetta archive <list\|purge\|restore\|rename> ...` | Archive operations on pages and fragments |
| `gazetta help` | Print the built-in help |

Any other command prints "Unknown command" and the help, and exits 1. The CLI looks for the site first, so where it finds none, or several, you get that error or question instead.

## Choosing the site and target

Arguments in square brackets are optional. The CLI fills them in:

**Site.** A `[site]` argument can be a site directory (`sites/main`), a name under `sites/` (`main`), or a project root that contains `sites/main`. Without one, the CLI uses the current directory if it has a `site.config.ts` (or `.js`, `.mjs`); otherwise it looks in `sites/`. One site there is used as is; with several, you're asked to choose. With none, the command stops and suggests `gazetta init`.

**Target.** For `publish`, `serve`, `deploy`, `history` and `undo`, and for `rollback` after its revision, the target argument is read as a site when it contains a `/` or is a directory with a site config; otherwise it's the target name. The other commands take the target first and the site after it. Without a target, these six commands use a site's only target (`publish` then stops: it needs a second target to publish to), and on a site with several they ask you to choose. The other commands use the editing target (below). So name the target in scripts:

```bash
npx gazetta publish staging
npx gazetta publish production sites/main
```

**Editing target.** Commands that read or change content (`publish` as the source, `dev`, `admin`, `validate`, `assets`, `archive`, `translate` without a target) use the first editable target in `site.config.ts`. A site with no editable target stops with an error that shows how to mark one; see [Targets](./targets.md).

## Ports and addresses

`dev`, `serve` and `admin` listen on port 3000. Change it with `--port <n>` or `-p <n>`. If the port is taken, the command says so and exits 1.

| Command | Listens on by default |
|---|---|
| `gazetta dev` | `127.0.0.1` only: it serves the admin API, and without auth anyone who reaches it is an admin |
| `gazetta admin` | `127.0.0.1` while `admin.auth` is `trust: 'none'` (the default); every interface when real auth is configured |
| `gazetta serve` | every interface: it serves only the site, as a container does |

`--host <address>` (or `--host=<address>`) overrides this, for example `npx gazetta dev --host 0.0.0.0` to open the site from a phone on the same network. `--host` on any other command is an error. See [Authentication and authorization](./auth.md) before exposing the admin.

## Commands

### `gazetta init [dir]`

Creates a project in `dir` (default: the current directory), then runs `npm install` in it. It refuses when `dir` already has a `sites/` folder or a `site.config.ts`. If `npm install` fails, the files stay in place, npm's error is shown, and the command exits 1; run `npm install` in the project yourself to finish. The new site depends on a range of the CLI's own version. [Getting started](./getting-started.md) walks through it.

`init` also writes an `AGENTS.md` with a section for coding agents (Claude Code, Codex, Copilot, Cursor). It tells the agent to install the Gazetta skill, which ships in the package at `node_modules/gazetta/agents/gazetta/`, into the folder its client reads skills from. The skill covers editing pages, fragments and translations, writing templates and schemas, and `gazetta validate`. It also lists the commands and admin routes an agent must never run itself (publishing, deploying, undo and rollback, purging, and deleting pages, fragments or assets) and must ask you about instead. Nothing enforces that list: on your own machine, only the agent and your agent client's own settings stop it. If `dir` already has an `AGENTS.md`, `init` adds the section at the end and leaves your text as it is. If it has a `CLAUDE.md`, `init` adds an `@AGENTS.md` import line to it, because Claude Code reads `AGENTS.md` only when a project has no `CLAUDE.md`.

The section and the skill carry the Gazetta version they came with; the section tells the agent to reinstall the skill when its installed copy is older. An existing project gets the instructions by copying the section from `node_modules/gazetta/agents/AGENTS.md` (everything between the `gazetta:agents` start and end markers) into its own `AGENTS.md`, replacing an older copy of the section, and by adding `@AGENTS.md` on a line of its own to `CLAUDE.md` if it has one.

### `gazetta dev [site]`

Runs the site at `http://localhost:3000/` and the admin at `/admin`, rendering pages from the editing target on each request. It watches templates, content and `site.config.ts`, and reloads the preview when they change; a `site.config.ts` change takes effect without a restart. At start it prints the pages, fragments and a Settings block (project, site, templates, editing target); set `GAZETTA_QUIET=1` to leave the Settings block out. Flags: `--port`, `--host`. Stop it with Ctrl+C.

### `gazetta publish [target] [site]`

Renders the site and writes it to the target, copying from the editing target. Only pages and fragments whose content, template or dependencies changed since the last publish to that target are written; the output says how many were skipped as unchanged.

| Flag | Effect |
|---|---|
| `--force`, `-f` | Publish every item, without checking what changed |

It stops before writing anything when the site has only one target ("nowhere to publish to"), when the target is the editing target itself, when the target doesn't exist, or when a template is invalid. It exits 1 when any item or target fails. The whole flow, the admin's Publish panel, and what the CLI doesn't do yet (choose a source, pick items, remove items) are in [Publishing](./publishing.md).

### `gazetta serve [target] [site]`

Serves a target's published output from its storage at `http://localhost:3000/`, the way a self-hosted server or container runs the site. It serves the site only, not the admin. A `static` target is served as files; a `dynamic` target has its pages assembled from fragments on each request. Flags: `--port`, `--host`. See [Self-hosted](./self-hosted.md).

### `gazetta build [site]`

Builds the admin into `dist/admin/` at the project root, and bundles the custom editors and fields in `admin/editors/` and `admin/fields/` with it. `gazetta admin` serves this folder. Run it again after changing an editor or field.

### `gazetta admin [site]`

Runs the admin from `dist/admin/` at `http://localhost:3000/admin`, without the dev server or file watching. It stops with "admin UI not built" until `gazetta build` has run. Flags: `--port`, `--host`.

### `gazetta deploy [target] [site]`

Runs the deploy adapter set as the target's `deploy:` field, for example the Cloudflare Worker. Deploy and publish are separate: deploy puts the runtime in place, publish writes the content. A target without `deploy:` stops with an example of how to add one. Exits 1 when the adapter fails. See [Deploy](./deploy.md) and [Cloudflare](./cloudflare.md).

### `gazetta validate [site]`

Checks every page and fragment for broken references (templates, fragments, assets), content that doesn't match its template's schema, and site config problems, plus custom editors without a template and fields a schema names that don't exist in `admin/fields/`.

| Flag | Effect |
|---|---|
| `--severity=<level>` | What to show and count: `error` (default), `warn` (errors and warnings) or `all` (also info). Write it with `=`: `--severity warn` would be read as a site named `warn` |
| `--include-quality` | Also render each page and run the accessibility, HTML validity and broken-link checks. Slower |
| `--no-warn-as-error` | Don't fail the run on warnings (with `--severity=warn` or `all`) |
| `--verbose`, `-v` | Show each issue, not just a mark per item |

Exit code: 1 when there are errors. With `--severity=warn` or `all`, warnings fail the run too, unless `--no-warn-as-error` is set; with the default `--severity=error`, a run with only warnings reports "All good." and exits 0. Site config issues and the editor and field checks are shown whatever `--severity` is.

### `gazetta translate <item> --to <locale> [target]`

Copies a page or fragment manifest as a new language version, for example:

```bash
npx gazetta translate pages/about --to fr
```

writes `pages/about/page.fr.json`, which you then edit. `<item>` starts with `pages/` or `fragments/`; `<locale>` is a language code such as `fr` or `pt-br` (`--to=fr` also works). It works on the named target, or the first editable target, and refuses when the language version already exists. See [Pages and fragments](./pages-and-fragments.md).

### `gazetta history [target] [site]`

Lists a target's revisions, newest first, with each one's id, operation, time and items. `--limit <n>` sets how many (default 50). On a target with `history: { enabled: false }` the command stops and says history is off.

### `gazetta undo [target] [site]`

Restores the target to the revision before its latest one, as a new revision. On a target with `environment: 'production'` it asks for confirmation; `--yes` (`-y`) skips the question.

### `gazetta rollback <rev> [target] [site]`

Restores a chosen revision, by the id `gazetta history` shows (`rev-...`), as a new revision. Production targets ask for confirmation as `undo` does.

On a publish destination, `undo` and `rollback` restore the content files but don't re-render the pages, so the live site doesn't change yet; see [Publishing](./publishing.md#destination-undo-does-not-change-served-pages-yet).

### `gazetta assets list|info|reindex`

```text
gazetta assets list [target] [site]
gazetta assets info <name> [target] [site]
gazetta assets reindex [target] [site]
```

`list` shows the assets on an editable target; `info` shows one asset's details, variants, language and theme versions, and where it's used; `reindex` rebuilds the dependency indices (which pages use which fragments and assets) from the manifests, for example after editing content outside the admin. Stop the dev server before reindexing. The target defaults to the editing target and must be editable. See [Content assets](./content-assets.md).

### `gazetta archive list|purge|restore|rename`

```text
gazetta archive list [--kind=page|fragment] [target] [site]
gazetta archive purge <name> [--kind=...] [--force] [target] [site]
gazetta archive restore <name> [--kind=...] [target] [site]
gazetta archive rename <oldname> <newname> [--kind=...] [--no-keep-alias] [--force] [target] [site]
```

Lists, permanently deletes and restores archived pages and fragments, and renames a live one, on an editable target, the same operations as the admin. `rename` keeps a redirect from the old name; `--no-keep-alias` drops it, and `--keep-alias` restores the default after an earlier `--no-keep-alias`. `--kind` is only needed when a page and a fragment share the name. See [Soft delete](./soft-delete.md#cli).

## In CI

The CLI treats any non-empty `CI` environment variable (GitHub Actions and most CI systems set `CI=true`) as non-interactive:

- It never asks a question. Where it would ask you to choose a site or target, it stops with an error listing the choices, so pass them as arguments.
- `undo` and `rollback` on a production target need `--yes`.
- `.env` and `.env.local` aren't loaded; set the variables in the CI environment.

Output has no colours when `NO_COLOR` is set or the output isn't a terminal.

## Environment files

Outside CI, every command except `init` loads `.env` and then `.env.local`, first from the project root and then from the site directory, before reading `site.config.ts`. A variable already set in the environment, or in a file loaded earlier, is kept. `site.config.ts` reads them as `process.env.NAME`; see [Targets](./targets.md) for secrets.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or you cancelled a question (choosing a site or target, confirming an undo) |
| `1` | Anything failed: an unknown command or target, a missing site, a failed publish item or target, validation errors, a port in use, a failed deploy |

`dev`, `serve` and `admin` keep running until you stop them with Ctrl+C.
