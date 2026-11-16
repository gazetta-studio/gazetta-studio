# Target storage is assumed public unless the target says otherwise; a public target keeps no sensitive state

> Context: every target keeps Gazetta's own files in a `.gazetta/` folder next to the published site: history (every past version, deleted images included), the audit log (actor IDs and email addresses), review state (approvers). When a host serves a target's storage directly (an S3 or Azure static website, an R2 bucket with public access, a folder served by nginx), those files were downloadable by anyone, and static `gazetta serve` served them too ([#1070](https://github.com/gazetta-studio/gazetta-studio/issues/1070), [#1071](https://github.com/gazetta-studio/gazetta-studio/issues/1071)). Decided in the design round of 2026-10-21; the details, the cut sequence and every rejected option are in [`design-public-storage.md`](../../.claude/rules/design-public-storage.md) (Q1–Q8).

The decision: **a target's storage is treated as public, reachable by visitors, unless the target is an editable filesystem target, its deploy adapter declares that it copies only site files to the host, or it sets `publicStorage: false`. A target with public storage keeps no history, audit or review state; Gazetta writes under its `.gazetta/` only folders the state folder registry marks safe.**

## Why

- **A forgotten setting must not leak.** Most cloud storage a site is served from can be reached by visitors, and nothing in a target's config shows whether it is. If storage were assumed private, an operator who never set the flag would publish past versions and people's email addresses; assumed public, the worst case is a target without undo, which the info line at `gazetta validate` and admin boot points out.
- **No sensitive state on a public target is a guarantee; blocking a path is advice.** Whether `/.gazetta/` is reachable depends on host rules Gazetta can't see. Not writing the files there holds whatever the host does.
- **Recovery comes from the source.** A public target receives what was published from a private one, whose history still holds every version: restore there and publish again.
- **One rule for what visitors may receive.** `isPublicSitePath` decides it for every server and deploy adapter: dot-prefixed paths (except `.well-known`) and Gazetta's manifest files are private.

## What was rejected

- **Private by default:** a forgotten declaration leaks, and only a check after the fact would notice.
- **Inferring from config** (static and no worker means public), or from `environment`: every local target and the starter's staging are static and private, so the rule would block normal development; and `environment` defaults to `local`, so a cloud bucket would be assumed private.
- **A second, private storage for a public target's state:** one more storage to configure and back up, for a rare setup; private storage plus a deploy adapter that copies site files already gives undo on a static host.
- **Encrypting history and audit:** losing the key loses history, deduplication breaks, and names, sizes and timestamps still leak.
- **An unguessable folder name:** hiding, not protection.

## Consequences

- Cloud targets lose history, undo and rollback, and keep no audit log of their own, unless they declare `publicStorage: false`. `gazetta init`, the starter and gazetta.studio set the value explicitly. Audit events for a public target are recorded on the publish's source, or the first private target, or nowhere, and Gazetta says when they're dropped.
- Contradictions are validation errors, not silent overrides: a public target with `history: { enabled: true }`, with an explicit `editable: true`, or whose storage still holds history, audit, review, CLI sign-ins or publish requests.
- `gazetta state remove <target>` deletes that state from a target's storage, for a target moved to public storage or a folder that was exposed.
- Every `.gazetta/` path is built through the state folder registry, which says per folder whether it may be written on a public target; a new folder is unsafe until its entry says otherwise.
- Content review and scheduling aren't available on a public target; publish approval is, since requests are kept on the source.
