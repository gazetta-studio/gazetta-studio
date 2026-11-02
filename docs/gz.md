# gz: edit a site from the command line

`gz` edits a Gazetta site through its admin, from a terminal or a script. It's for people who write content rather than templates, and for their AI agents. Everything goes through the admin's API, so saves are checked, recorded in history and audited like saves in the browser. Template developers use the [`gazetta` CLI](./cli.md) instead.

## Install

`gz` isn't released yet. Until it is, build it from the repository with [Go](https://go.dev/dl/) 1.26 or later:

```bash
git clone https://github.com/gazetta-studio/gazetta-studio
cd gazetta-studio/gz
go build -o gz ./cmd/gz    # then move gz onto your PATH
```

Once released, it will install with Homebrew (`brew install gazetta-studio/tap/gz`), an install script for macOS, Linux and Windows, or npm (`npm install -g @gazetta/cli`). Each also installs a copy named `gazetta-cli`, for machines where Gazebo's robotics tools already have a command called `gz`.

## Sign in

```bash
gz auth login https://cms.example.com
```

`gz` shows a code, like `ABCD-EFGH`, and opens the admin's approve page. Check that the page shows the same code and your machine, then approve it. The login lasts 30 days, after which `gz` asks you to approve a new code. Behind some login layers you add a flag or two; your site's operator will tell you which ([per login layer](./auth.md#behind-each-login-layer)).

For a site running on your own machine with `gazetta dev`, sign in to `http://localhost:3000`.

Each admin you sign in to is a profile, named after its address or with `--name`. The first one becomes the default.

- `gz auth list` lists your profiles.
- `gz auth use <name>` changes the default.
- `--admin <name>` or `GZ_ADMIN` picks another profile for one command.
- `gz auth status` says which admin `gz` will use and whether its login still works.
- `gz auth logout` signs out and revokes the login.

`gz` keeps logins in your system's keychain, or in a file only you can read where there's none (`GZ_CONFIG_DIR` sets the folder).

## Read and change content

```bash
gz pages list                       # names, routes, templates and languages
gz pages get home                   # the manifest, as stored
gz templates schema hero            # the fields a hero component takes
gz pages set home components.hero.content.title="Spring sale"
```

- **`gz pages set`** changes values in place. A path is dot-separated; in a list of components, use the component's name (`components.hero`).
  - `=` sets a string; `:=` sets JSON (`components.hero.content.count:=3`); `@file` reads a value from a file (`content.body=@body.md`).
  - Several pages in one command are saved all or nothing.
  - `--from <dir>` saves whole manifests from a folder, one `<name>.json` per page.
- **`gz pages edit home`** replaces the whole manifest, from stdin or in your `$EDITOR`.
- **`gz pages create news --template page-default`** creates a page. With `--locale fr`, it creates the French version of a page that exists.
- **`--locale fr`** on `get`, `set` and `edit` works on a language version.

`gz fragments list`, `gz fragments get`, `gz fragments set`, `gz fragments edit` and `gz fragments create` do the same for fragments.

If someone else saved the page since you read it, the save is refused (exit code 4) and nothing changes. Read it again and redo your change.

## Check your work

- `gz validate` lists the site's validation issues, and exits 1 if any is an error.
- `gz preview home` prints the page's preview URL in the admin. With `--html` it prints the rendered page, which an agent can read.
- `gz status` lists the changes not yet published to the next target (`--target` picks another).

## Publish

```bash
gz publish home @header --to staging
```

A `@` names a fragment; `--all` publishes every change `gz status` lists. Publishing needs an elevation: `gz` shows a code, you approve it in the admin, and `gz` publishes. For the next 15 minutes, publishing from that login needs no new code. Production needs its own elevation, which also covers the other targets.

- `--no-wait` prints the code and exits 3 instead of waiting. In CI without a terminal, `gz` never waits.
- `gz elevate` asks for an elevation ahead of time (`--production` for production).
- `gz elevate --end` ends yours early.

## Images and files

```bash
gz assets list
gz assets upload photo.jpg --alt "The team at the summer party"
gz assets alt photo "The team at the summer party, 2026"
```

`gz assets upload` names an asset after its file unless you give `--name`; it prints the name the admin saved it under. Uploading under a name that already exists currently replaces that asset ([#1349](https://github.com/gazetta-studio/gazetta-studio/issues/1349)), so check `gz assets list` first. `--decorative` marks an image that needs no alt text.

## Runs: one task, one set of changes

A run groups the saves of one task, so they can be reviewed and undone together. Set `GZ_RUN` once per task, to a short id of your own:

```bash
export GZ_RUN=fix-footer-links
```

Without it, each `gz` command is its own run; `--run <id>` sets one for a single command.

To undo a run, `gz runs show fix-footer-links` lists what it changed and what reverting would do, and `gz runs revert fix-footer-links` undoes it item by item:

- changed items go back to their version before the run;
- items the run created are archived;
- items someone else changed since are skipped, unless you name them with `--force pages.about,pages.home`.

The revert is a run of its own, so you can revert it too.

## Output and exit codes

`gz version` (or `--version`) prints the version. `gz` prints text for people; `--json` prints JSON for scripts, with the admin's error codes. It never asks a question when it isn't run in a terminal.

| Code | Meaning |
|---|---|
| `0` | Done |
| `1` | Something failed: a validation error, a failed publish, a revert that skipped items |
| `2` | The command or its arguments were wrong |
| `3` | Sign in, or approve an elevation, first |
| `4` | Someone else changed it since you read it |
| `5` | No such page, fragment, asset or run |

## For AI agents

`gz skill install <dir>` writes Gazetta's skill for coding agents into `<dir>`, the folder your agent reads skills from (for example `.claude/skills` or `.agents/skills`). The skill teaches the agent the content model and the commands above. `gz skill` prints it instead.

The skill carries the version of `gz` that wrote it. When a copy that `gz skill install` wrote is older than `gz`, `gz` says so, at most once a day.

### What agents leave to you

The skill tells agents never to run these, and to ask you instead:

- publishing (`gz publish`) and elevations (`gz elevate`);
- deleting pages, fragments or assets;
- approving sign-ins, elevations, publish requests or review requests.

Behind most login layers, Gazetta also enforces it: an agent's login can only edit until you approve an elevation. On Tailscale, and on your own machine with `gazetta dev`, nothing but the agent's judgement and your agent client's settings stops it ([where it's enforced](./auth.md#where-can-only-edit-is-enforced)).
