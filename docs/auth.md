# Authentication and authorization

Gazetta's admin uses **upstream identity** + **role-based capability gates**. The platform fronting your admin (Cloudflare Access, Azure App Service Easy Auth, AWS ALB + Cognito, Tailscale, oauth2-proxy / Authelia / Caddy `forward_auth`, …) authenticates users; Gazetta reads the verified identity from request headers and matches each route to a capability the user's role grants.

Gazetta does not store passwords, issue JWTs, run OAuth flows, or display login screens. Auth is done before requests reach Gazetta.

## Quick start

The default is `none` — single-author / dev mode. Every request is granted the admin role; no auth is checked.

To opt in to upstream auth, add an `admin.auth` block to your `site.config.ts`:

```ts
import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'main',
  targets: {
    local: { storage: filesystemStorage(), environment: 'local', editable: true },
  },
  admin: {
    auth: {
      trust: 'cloudflare-access',
      teamDomain: 'acme', // your team domain at https://acme.cloudflareaccess.com
      audience: 'https://admin.example.com', // optional but strongly recommended
    },
  },
})
```

## Trust modes

Each trust mode tells Gazetta how to extract identity from the upstream layer's request shape.

### `none` (default)

Single-author / dev mode. Every request resolves to the canonical `unknown` principal with the admin role. Ignores all upstream headers — a misconfigured proxy can't leak identity into a `none`-mode deployment.

```ts
admin: { auth: { trust: 'none' } }
```

Or simply omit `admin.auth` entirely.

### `forwarded-user`

Generic reverse-proxy mode for deployments behind oauth2-proxy, Authelia, Caddy `forward_auth`, traefik ForwardAuth, etc. The upstream layer authenticates and sets:

- `X-Forwarded-User` (required) — opaque user id
- `X-Forwarded-Email` (optional)
- `X-Forwarded-Groups` (optional, comma-separated; reserved for future role-mapping)

**`trustedProxies` is required.** The forwarded headers carry no signature; anything that reaches the admin can set them. Gazetta accepts them only on a connection from an address in `trustedProxies`: the proxy's address as the admin's server sees it. Addresses named in headers such as `X-Forwarded-For` don't count. List the proxies that connect to the admin directly.

```ts
admin: {
  auth: {
    trust: 'forwarded-user',
    trustedProxies: ['10.0.0.0/8', 'fd00::/8'], // IPv4 + IPv6 CIDRs supported
  },
}
```

For dev environments or trusted private networks (Tailscale, internal VPNs):

```ts
admin: {
  auth: {
    trust: 'forwarded-user',
    allowAnyOrigin: true, // explicit opt-out of the trusted-proxy check
  },
}
```

Without `trustedProxies` AND without `allowAnyOrigin`, admin boot fails — there's no safe default.

### `cloudflare-access`

Cloudflare Zero Trust / Access fronting the admin. Gazetta verifies the JWT in `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) against Cloudflare's published JWKS.

```ts
admin: {
  auth: {
    trust: 'cloudflare-access',
    teamDomain: 'acme', // your team's subdomain at *.cloudflareaccess.com
    audience: 'https://admin.example.com', // optional but strongly recommended
  },
}
```

Setting `audience` prevents token replay across other Access-protected apps in the same team domain. Cloudflare Access automatic key rotation is handled by `jose`'s `createRemoteJWKSet`.

### `azure-easy-auth`

Azure App Service's built-in authentication ("Easy Auth"). The platform sandboxes the admin and populates `X-MS-CLIENT-PRINCIPAL` with a base64-encoded JSON description of the principal.

```ts
admin: { auth: { trust: 'azure-easy-auth' } }
```

The App Service sandbox is the trust boundary. **Do not run `gazetta serve` directly with this trust mode** — without the sandbox, anyone can set the header.

### `aws-cognito`

AWS Application Load Balancer fronting the admin with Cognito user pool authentication. The ALB injects a signed JWT in `x-amzn-oidc-data` against AWS's per-region public keys.

```ts
admin: {
  auth: {
    trust: 'aws-cognito',
    region: 'us-east-1',
    // Required: the load balancer in front of the admin (or a list of them)
    albArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/my-admin/50dc6c495c0c9188',
    audience: 'cognito-app-client-id', // optional but recommended
  },
}
```

Every ALB in a region signs with keys from the same endpoint, so Gazetta accepts a token only when its header's `signer` is one of the `albArn` values, as AWS's documentation says to check, and only until the header's `exp`. Downloaded public keys are cached per process in a small LRU (16 keys); an ALB key never changes for a given key id, so eviction only costs a refetch.

### `tailscale`

Tailscale Serve fronting the admin on the same machine. Serve passes tailnet requests to the admin on `localhost` and adds identity headers for the signed-in tailnet user. Funnel requests carry none, so they're anonymous.

```ts
admin: { auth: { trust: 'tailscale' } }
```

The header `Tailscale-User-Login` (e.g., `alice@example.ts.net`) carries the identity. Gazetta accepts it only on a connection from the same machine (`127.0.0.1` or `::1`), which is how Serve connects; identity headers on any other connection get `401`. Run the admin where Serve runs, and start it with `--host 127.0.0.1` so it's reachable only through Serve, as Tailscale recommends.

Every tailnet user who reaches the admin gets the same role: `defaultRole`, a built-in role or one declared in `roles` (default `editor`). Serve sends no group information, so `roleMapping` isn't supported in this mode and is refused at startup. Use tailnet ACLs to decide who can reach the admin.

```ts
admin: { auth: { trust: 'tailscale', defaultRole: 'viewer' } }
```

## Roles and capabilities

Roles are predefined capability sets. Each authenticated user gets exactly one role.

### Built-in roles

| Role | Capabilities |
|---|---|
| `admin` | `*` (everything) |
| `editor` | `read:*` + `edit:*` + `publish:non-production` |
| `viewer` | `read:*` |

Editor explicitly does NOT have `publish:production` or `delete:*` or `configure:site`.

### Capability vocabulary

| Domain | Capabilities |
|---|---|
| Read | `read:pages`, `read:fragments`, `read:assets`, `read:audit-log` |
| Edit | `edit:pages`, `edit:fragments`, `edit:assets`, `edit:locale-variants` |
| Delete | `delete:pages`, `delete:fragments`, `delete:assets` |
| Publish | `publish:non-production`, `publish:production` |
| Configure | `configure:site`, `configure:targets` |
| History | `restore:history` |
| Wildcards | `read:*`, `edit:*`, `delete:*`, `publish:*`, `*` |

### Custom roles

Operator-defined in `site.config.ts`:

```ts
admin: {
  auth: {
    trust: 'cloudflare-access',
    teamDomain: 'acme',
    roles: {
      translator: {
        capabilities: ['read:pages', 'read:fragments', 'read:assets', 'edit:locale-variants'],
      },
      auditor: {
        capabilities: ['read:*', 'read:audit-log'],
      },
    },
  },
}
```

Custom roles can't redefine built-in role names (`admin`, `editor`, `viewer`) — that's flagged at boot.

### Group-claim → role mapping

(Reserved for follow-up.) v1 ships with every authenticated user getting the configured `defaultRole` (currently `editor`). Future work threads upstream group claims through the role-resolver to map to roles.

## Failure modes

Gazetta answers auth failures, like every admin-API error, as `application/problem+json` (RFC 9457): `type`, `title`, `status`, a human-readable `detail`, and a `code`, plus any extra members listed below.

| Status | Body | When |
|---|---|---|
| `401 UNAUTHENTICATED` | problem with `code: "UNAUTHENTICATED"` + `WWW-Authenticate: Bearer realm="gazetta-admin"` | No identity (forwarded-user with missing header, JWT missing/expired/invalid signature, connection not from an address in `trustedProxies`, Tailscale identity headers not from the same machine) |
| `403 FORBIDDEN` | problem with `code: "FORBIDDEN"`, `missing: [cap]` and `role` | Authenticated principal lacks the capability the route requires |

Authenticated users see what they can't do (the `missing` capability + their `role`). Unauthenticated requests get the generic `WWW-Authenticate` hint pointing back at the upstream layer — Gazetta doesn't issue login challenges itself.

## Per-route capability matrix

API routes live under `/api/v1` (under `/admin/api/v1` when the admin is mounted at `/admin`), and `GET /api/version` lists the API versions the admin supports. Every `/api/v1/*` route gates on a specific capability. The route → capability mapping:

| Routes | Capability |
|---|---|
| `GET /api/v1/site`, `/api/v1/pages*`, `/api/v1/fragments*`, `/api/v1/templates*`, `/api/v1/fields`, `/api/v1/compare`, `/api/v1/history`, `/api/v1/targets`, `/api/v1/dependents` | `read:pages` (or scoped `read:fragments` / `read:assets`) |
| `POST/PUT /api/v1/pages*`, `/api/v1/fragments*` | `edit:pages` / `edit:fragments` |
| `DELETE /api/v1/pages/*`, `/api/v1/fragments/*` | `delete:pages` / `delete:fragments` |
| `GET /api/v1/assets*` | `read:assets` |
| `POST/PATCH /api/v1/assets*` | `edit:assets` |
| `DELETE /api/v1/assets/:name` | `delete:assets` |
| `POST /api/v1/history/{undo,restore}` | `restore:history` |
| `POST /api/v1/publish*`, `/api/v1/fetch` | `publish:non-production`; publishing to, or fetching into, a target whose `environment` is `production` also needs `publish:production` |
| `GET /api/v1/system/cache/*` | `configure:site` |
| `GET /api/health` | (no gate; intentionally public) |
| `GET /api/version` | (no gate; the exact Gazetta version is included only for a signed-in caller) |
| `/api/v1/auth/*` | (no capability; approving or denying a sign-in needs a signed-in browser, see [Signing in from the command line](#signing-in-from-the-command-line)) |

## Signing in from the command line

A command-line client, such as `gz` and the agents that run it, signs in as you with a Gazetta token. You approve each sign-in in your browser.

1. The client starts a sign-in and shows you a code, like `ABCD-EFGH`, and a link to the admin.
2. You open the link in your browser. The page shows the code, the machine name, the IP address and when the sign-in started. Approve it only if you started it yourself: anyone who gets you to approve their code can edit content as you.
3. The client receives a token and keeps a grant to renew it. A token lasts 15 minutes and travels in the `Gazetta-Token` header. A code works once and expires after 10 minutes.

A token has your role's capabilities except publishing, deleting (purge included), undo, rollback and history restore, and approving publish requests. Without an elevation (below), those answer `403` with the code `ELEVATION_REQUIRED` and the `scope` to ask for; if your role can't do them in the admin either, the code is `TOKEN_EDIT_ONLY`. A token that is wrong or expired is refused with `401` (`TOKEN_INVALID`); the request is never treated as coming from your browser instead.

A grant renews tokens for 30 days from the sign-in's approval. After that, renewing answers `401` (`GRANT_EXPIRED`), and the client signs in again. A grant keeps the role you had when you approved it: if your role changes, sign in again.

To end a sign-in, revoke its grant: `DELETE /api/v1/auth/grants/:id`. The client can't get new tokens after that, its elevations end, and the token it holds stops working within 15 minutes.

### Elevations: publishing from the command line

To publish, delete or restore, the client asks for an elevation, and you approve it in your browser the same way as a sign-in.

1. With its token, the client calls `POST /api/v1/auth/elevations` with a scope, `non-production` (every target whose `environment` isn't `production`) or `production`, and shows you a code and a link.
2. The page says what you're allowing, for example "Allow laptop to publish to production for a short time", with the machine, IP address and start time. Approve it only if you started it yourself. Only the person the client signed in as can approve it, and only if their role still has the capabilities it would use.
3. For the next 15 minutes, that sign-in's tokens can do what your role can do in the admin, on targets in the scope. The window is fixed: using it doesn't extend it. A production publish needs a production elevation even while a non-production one is active.

The page shows when the elevation ends, with **End now**. The client can also end it with `DELETE /api/v1/auth/elevations/:id`. Ending one takes effect at once on every instance of the admin.

Set the window with `admin.auth.elevationMinutes` (default `15`):

```ts
admin: { auth: { trust: 'cloudflare-access', teamDomain: 'example', audience: '…', elevationMinutes: 10 } }
```

### Turning it on

Command-line sign-in is on when the admin has a signing key. Generate one and give the same value to every instance of the admin as `GAZETTA_SIGNING_KEY`:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
```

The value is the whole PEM. Where a host stores environment variables on one line, write the line breaks as `\n`. Without the key, the sign-in routes answer `503` (`CLI_LOGIN_UNAVAILABLE`) and the rest of the admin works as usual. `gazetta dev` generates a key of its own each time it starts.

To change the key, move the old value to `GAZETTA_SIGNING_KEY_PREVIOUS` and set the new one. Tokens signed with the old key keep working until they expire; remove `GAZETTA_SIGNING_KEY_PREVIOUS` after 20 minutes. Grants are kept, so clients don't sign in again.

Grants and elevations live in the editing target's storage, in `.gazetta/auth/`. They hold who signed in and from which machine, never a usable secret. `gazetta state remove` deletes them. If the editing target's storage is public, sign-in stays off.

### Where "can only edit" is enforced

The approve page refuses requests that carry a Gazetta token, so a token can't approve a sign-in or an elevation, or extend itself. That holds when the client reaches the admin with a credential of its own, such as a Cloudflare Access service token. On Tailscale the client's requests arrive with the same identity as your browser's, and probably also with `cloudflared access login` (not yet checked), so Gazetta can't tell them apart: there, only the agent's own judgement and your agent's settings stop it from publishing, as on your own machine.

## Composing with the bearer-token guard

The legacy `GAZETTA_TOKEN` environment variable adds an `Authorization: Bearer <token>` check to every `/api` request, before the principal middleware. Two limits:

- The token carries no identity. With any `trust` mode other than `none`, a request with only the bearer token has no principal and is refused (`401`), so the token can't give CI or scripts access to an admin behind upstream auth.
- The admin's own browser requests don't send the token, so setting `GAZETTA_TOKEN` also locks out the admin UI. Use it only for a server reached through the API alone, with `trust: 'none'`.

For the command line and agents on hosted admins, use [Gazetta tokens](#signing-in-from-the-command-line) instead.

```bash
GAZETTA_TOKEN=$(openssl rand -base64 32) gazetta serve
```

## Multi-instance correctness

- `Principal` is per-request; nothing is cached cross-request
- Role-mapping table loads from `site.config.ts` at boot; reread on `site.config.ts` change via the dev file watcher
- `cloudflare-access` JWT verification uses `createRemoteJWKSet` which fetches + caches keys per-instance; rotations are picked up by each instance independently. `aws-cognito` fetches ALB keys per key id and caches them in a bounded LRU (no expiry needed; a key never changes for its kid)
- Source-IP whitelist parses once at boot; per-request matches are O(N) over already-parsed rules

## Operational notes

- **Boot fails fast** on misconfigured `admin.auth`. An invalid trust mode, missing required field (e.g., `cloudflare-access` without `teamDomain`), or missing `trustedProxies`-without-`allowAnyOrigin` for `forwarded-user` throws `AuthConfigurationError` before the admin starts serving.
- **JWT verification fails closed.** If Cloudflare's JWKS endpoint is unreachable, Gazetta returns 401 — does not let unsigned tokens through.
- **Logs do not include credentials.** Auth failure messages surface to the operator (admin-API audience) but never leak token contents.
