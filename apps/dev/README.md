# apps/dev

The Maskin backend API — Hono + OpenAPI, Drizzle over Postgres, Vitest for
unit + integration tests. Consult the repo root `README.md` for the full
monorepo picture; this file only carries `apps/dev`-specific notes that
don't fit elsewhere.

## Environment variables

All shared env vars are documented in the repo-root `.env.example`; skim that
file end-to-end when standing up a new stack. This section documents variables
that are specific to `apps/dev` and land here first before we consider
promoting them.

### Keychain — credential encryption and audit

Stored credentials use envelope encryption. Each credential gets its own random
32-byte data key (DEK); the credential is AES-256-GCM encrypted under it and the
DEK is wrapped by one master key (`KEYCHAIN_MASTER_KEY`) that is held in the environment, not in the database.
Rows written before Keychain have no wrapped DEK and keep decrypting under
`INTEGRATION_ENCRYPTION_KEY`. Every read goes through `getCredential`, which
enforces the credential's agent grants (see `docs/reference/agent-access.md`) and writes a hash-chained row to
`credential_access_log`.

| Variable | Meaning |
|----------|---------|
| `KEYCHAIN_MASTER_KEY` | 32 bytes as 64 hex characters. Wraps every credential's data key (AES-256-GCM, with the workspace id as additional data). Required in production: unset warns at start and fails on the first envelope write. Outside production an unset key is derived from `INTEGRATION_ENCRYPTION_KEY`. A malformed value stops the server at start. Lose it and every envelope credential is unrecoverable, so keep a copy in the secret store. The key never goes in the database. |
| `KEYCHAIN_MASTER_KEY_PREVIOUS` | Optional. The key being replaced during a rotation. Unwrapping tries `KEYCHAIN_MASTER_KEY` first, then this one; wrapping always uses the current key. |

Generate a key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

**Rotating the master key.** Set the new key as `KEYCHAIN_MASTER_KEY` and the old one as `KEYCHAIN_MASTER_KEY_PREVIOUS`, then restart. The nightly DEK job re-wraps each credential under the new key after it is read. Drop the previous key only when no credential is left under it, and not while an old database backup you still need holds DEKs wrapped under it.

**Audit log role.** Migration 0087 creates the NOLOGIN role `maskin_keychain_app`
with INSERT and SELECT on `credential_access_log`, and `getCredential` writes the
audit row as that role. Running the migration needs CREATEROLE or superuser.

### LinkedIn — LinkedIn Hosted Auth v2

See the technical spec in the parent bet
(**First-party LinkedIn MCP — customer-auth**) and the
provider directory at
`apps/dev/src/lib/integrations/providers/linkedin-unipile/`.

- **UNIPILE_BASE_URL** — LinkedIn provider v2 REST API base. Docs default is
  `https://api.unipile.com`; a tenant may issue a tenant-subdomain host
  instead. The value must NOT include the `/v2` path suffix — the client
  concatenates the path. No trailing slash. See
  https://developer.unipile.com/v2.0/docs.
- **UNIPILE_API_KEY** — the workspace-agnostic Maskin-owned API key sent as
  `X-API-KEY` on every LinkedIn request.
- **UNIPILE_WEBHOOK_SECRET** — Unipile v2's per-endpoint signing secret
  (`wes_...`, returned by `POST /v2/webhooks/endpoints/` at endpoint
  creation and viewable in the Unipile dashboard). Required by the R11-C
  fan-out webhook (`POST /api/integrations/linkedin-unipile/webhook`),
  which verifies the `unipile-signature` HMAC-SHA256 header against this
  secret. Docs:
  https://developer.unipile.com/v2.0/docs/configure-a-webhook. Note:
  this secret is per-webhook-endpoint, not per-application — rotate the
  secret by deleting the endpoint and creating a new one, then redeploy.
- **MASKIN_PUBLIC_URL** — public base URL of this API instance. Passed to
  LinkedIn v2 as `redirect_uri` at auth-link creation time
  (`{MASKIN_PUBLIC_URL}/api/integrations/linkedin-unipile/callback`) and
  used to build the post-callback redirect back to Settings > Integrations.
  Defaults to `http://localhost:3000` when unset.

Callback URLs to register with LinkedIn partnerships as `redirect_uri`
allowlist entries on the v2 hosted-auth application:

- Prod: `https://api.maskin.io/api/integrations/linkedin-unipile/callback`
- Dev:  `https://api.dev.maskin.io/api/integrations/linkedin-unipile/callback`

## Tests

```
pnpm --filter @maskin/dev test
```

Unit tests live under `src/__tests__/`. The Vitest suite is fully offline —
no live LinkedIn / LinkedIn / Slack calls are made. See
`src/lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server.ts`
for the in-process LinkedIn mock server used by the LinkedIn tests.
