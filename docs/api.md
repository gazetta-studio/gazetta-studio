# Admin API

The admin, [`gz`](./gz.md) and your own scripts all use the same HTTP API. This page covers what applies to every route: versions, errors, headers, and where to find the routes themselves.

## Versions

Routes live under `/api/v1` (`/admin/api/v1` when the admin runs at `/admin`, as `gazetta dev` and `gazetta admin` mount it). Within a major version, changes only add things: new routes, new optional fields, new error codes and new values in lists. A client should accept codes and values it doesn't know. A change that removes or renames something, or makes something required, goes into a new major.

`GET /api/version`, outside the versioned prefix, lists the majors the admin serves (`{ "majors": ["v1"] }`), so a client can check before it picks one. Signed-in callers also get the exact Gazetta version.

Version 1 is a preview until the route changes already planned land; it may still change.

### Deprecation

A route or field being removed stays for at least two minor releases or 6 months, whichever is longer. Meanwhile responses carry a `Deprecation` header (when it was deprecated) and a `Sunset` header (when it goes), and the OpenAPI document marks it deprecated.

## The routes

The OpenAPI 3.1 document at `/api/v1/openapi.json` lists every route, with its parameters, request and response schemas, and the error codes it can answer. It needs no sign-in. Load it into any OpenAPI viewer or client generator; `gz`'s client is generated from it.

Which role capability each route needs is in [Authentication and authorization](./auth.md#per-route-capability-matrix).

## Errors

Errors are `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)): `type`, `title`, `status`, a readable `detail`, and a `code` naming the error, such as `STALE`, `VALIDATION_FAILED` or `ELEVATION_REQUIRED`. Some codes carry more fields: a validation failure lists its `issues`, an elevation refusal names the `scope` to ask for. Branch on `code`, not on `detail`'s text.

## Headers

| Header | Direction | What it does |
|---|---|---|
| `Gazetta-Token` | request | A command-line sign-in's token ([signing in from the command line](./auth.md#signing-in-from-the-command-line)). Behind AWS ALB it goes in `Authorization: Bearer` instead. |
| `Gazetta-Run` | request | The agent run the request's writes belong to: letters, digits, `.`, `_` and `-`, up to 64 characters. Revisions and audit events record it, so a run can be reviewed and reverted. |
| `ETag` / `If-Match` | response / request | A page's or fragment's save-version. Send it back as `If-Match` when saving; if someone saved in between, the save answers `409` with `STALE` and changes nothing. |

## Saving several items at once

`POST /api/v1/saves` saves up to 100 pages and fragments as one change, all or nothing. Every item is checked first (its `ifMatch`, the save's validation, `beforeSave` hooks). If any fails, nothing is written, and the `409 BATCH_REFUSED` problem lists each failing item. Otherwise everything is written and recorded as one history revision in the request's run, so it needs a `Gazetta-Run` header. An item with `ifNoneMatch: "*"` instead of `ifMatch` is created.

## Reverting a run

`GET /api/v1/runs/:runId` lists what a run changed, and `POST /api/v1/runs/:runId/revert` undoes it item by item:

- items the run changed go back to their version before the run;
- items the run created are archived;
- items someone changed since are skipped unless the request names them in `force`;
- items that can't be saved or archived are skipped with the reason.

The revert is a run of its own, so it can be reverted too. `gz runs revert` does this from the command line.
