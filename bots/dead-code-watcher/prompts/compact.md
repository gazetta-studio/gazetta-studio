# Dead-code-watcher — monthly compaction prompt

You are compacting the bot's skip-list (`bots/dead-code-watcher/skip-list.json`).

**Goal:** identify groups of ≥3 entries that share a generalizable
pattern, replace them with a single rule. The skip-list ends up
smaller AND more powerful — fewer concrete entries, more rules that
catch future findings of the same shape.

## Inputs (appended below)

- `SKIP_LIST_PATH` — relative path to the skip-list file
- `SKIP_LIST_JSON` — the full current skip-list state
- `RUN_ID` — this watcher's GH Actions run ID (for outcome tags)

## Decision-log convention

Articulate every proposed compaction with `> Decision: ...`. The
maintainer needs to see your reasoning — they'll review the PR diff
plus your commit message.

## What "compaction" actually means

Concretely: replace N skip-list entries (each tied to one specific
fingerprint) with M rules (each tied to a glob scope + reason).

**Example.** Skip-list before:

```json
{
  "entries": [
    {"fingerprint": {"kind": "export", "path": "packages/gazetta/src/index.ts", "symbol": "X"}, "reason": "public-api"},
    {"fingerprint": {"kind": "export", "path": "packages/gazetta/src/types.ts", "symbol": "Y"}, "reason": "public-api"},
    {"fingerprint": {"kind": "type", "path": "packages/gazetta/src/types.ts", "symbol": "Z"}, "reason": "public-api"},
    {"fingerprint": {"kind": "export", "path": "packages/gazetta/src/schema.ts", "symbol": "W"}, "reason": "public-api"}
  ]
}
```

After:

```json
{
  "entries": [],
  "rules": [
    {
      "rule": "gazetta-public-api-entries",
      "scope": "packages/gazetta/src/{index,types,schema}.ts",
      "kinds": ["export", "type"],
      "reason": "public-api",
      "reasonNote": "These files are public-API entry points per gazetta/package.json exports map. External consumers may use any exported symbol.",
      "addedAt": "<ISO-8601 now>",
      "addedBy": "bot",
      "compactedFrom": 4
    }
  ]
}
```

4 specific entries → 1 general rule. The rule **also** matches any
future export added to those files — that's the "more powerful"
part.

## Process

### 1. Read the current skip-list

Parse `SKIP_LIST_JSON`. Group entries by `reason` + path-prefix.

### 2. Look for compactable groups

A group is compactable when ALL of these hold:

- **3+ entries** share the same `reason` field
- They share a path-prefix or a glob-collapsible pattern
- The generalization is sound: the rule, when applied to the
  shared scope, would correctly capture the original entries AND
  any future findings of the same shape

**Be conservative.** When you're unsure whether a generalization is
sound, DON'T compact. False compactions create false skips (real
dead code that should be removed but the rule blocks the bot from
filing a PR).

**Examples of safe compactions:**

- 4 entries all under `packages/gazetta/src/*.ts` with reason
  `public-api` → rule scope `packages/gazetta/src/*.ts`
- 5 entries all under `examples/starter/templates/*/index.ts` with
  reason `dynamic-load` → rule scope `examples/starter/templates/*/index.ts`
- 3 entries all of kind=`devDependency` in same `package.json` with
  reason `needs-human` → tighten the original entries (don't compact)

**Examples of UNSAFE compactions:**

- 3 entries in `packages/gazetta/src/` but with mixed reasons
  (`public-api` × 2 + `maintainer-rejected` × 1) → don't compact
- 3 entries with `reason: maintainer-rejected` but different
  rejection notes → the maintainer's reasoning differs per entry;
  don't generalize
- Anywhere reason is `other` → free-text reason means the entries
  don't share a structural pattern, just a label

### 3. Compose new rules

For each compactable group, write a rule:

```json
{
  "rule": "<descriptive-id>",       // kebab-case, stable
  "scope": "<glob>",                 // matches all replaced entries
  "kinds": ["<kind>", ...],          // optional — restrict to specific kinds
  "reason": "<same as replaced>",
  "reasonNote": "<one-paragraph why this generalization is sound>",
  "addedAt": "<ISO-8601 now>",
  "addedBy": "bot",
  "compactedFrom": <count>           // how many entries this rule replaced
}
```

Pick the `scope` glob carefully:

- `path/to/file.ts` — exact (single entry, no compaction)
- `path/to/*.ts` — single directory
- `path/to/**/*.ts` — recursive
- Brace expansion (`{a,b}.ts`) is NOT supported by the skip-list's
  glob matcher — use multiple rules if you need it

Use `kinds: [...]` to restrict when the original entries all share
a kind. Omit when the rule should match any kind under the scope.

### 4. Build the new skip-list

```ts
const newList = {
  version: 1,
  entries: <originalEntries minus compacted ones>,
  rules: <originalRules + new rules>
}
```

### 5. Write to disk + open PR

```bash
# Write the new skip-list (use Edit/Write tool to format JSON cleanly
# with 2-space indent + trailing newline; match existing file format)

git checkout -b dead-code-compact/$(date -u +%Y-%m)
git add $SKIP_LIST_PATH

# Format prevents diff churn
npm run format

git commit -m "$(cat <<EOF
chore(skip-list): monthly compaction — $entriesBeforeCount entries → $rulesAfterCount rules

Replaces $compactedCount specific skip-list entries with $rulesAfterCount
generalized rules. Each rule's reasonNote explains why the
generalization is sound.

<list of rule names + their compactedFrom counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push -u origin dead-code-compact/$(date -u +%Y-%m)

gh pr create --title "chore(skip-list): monthly compaction" --body "$(cat <<EOF
## Why

Monthly memory compaction per the dead-code-watcher design.

Before: $entriesBeforeCount entries + $rulesBeforeCount rules
After:  $entriesAfterCount entries + $rulesAfterCount rules

## Rules proposed

<per-rule section explaining:
  - what entries it replaces
  - why the generalization is sound
  - what future findings it would also catch>

## What if a rule is too broad?

Edit \`$SKIP_LIST_PATH\` in this PR (or a follow-up) to either:
- Narrow the rule's scope
- Replace the rule with the original concrete entries

The bot reads the file as-is on next weekly run.

<!-- dead-code-watcher: compact run=$RUN_ID -->
EOF
)"
```

## Rules

- **Conservative beats aggressive.** A skip-list with too many
  entries is annoying; a skip-list with wrong rules is dangerous
  (skips real dead code).
- **Never compact `reason: maintainer-rejected` entries.** Each
  rejection is a specific maintainer decision; generalizing across
  them risks creating a rule the maintainer didn't agree to.
- **Never compact when fewer than 3 entries share the pattern.**
  Threshold codifies "I've seen this pattern multiple times, not just
  once."
- **Always document `reasonNote` on rules.** Future maintainers
  (and the bot itself) need to understand the generalization.
- **Don't ask the user questions.** Headless in CI. If you can't
  find ≥3 compactable entries, exit cleanly with no PR.
- **One compaction PR per run.** If you find multiple separate
  compactions, bundle them into ONE PR — the maintainer reviews the
  full month's compaction in one place.
