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
DEK is wrapped by a per-workspace key (KEK) that never leaves the key store.
Rows written before Keychain have no wrapped DEK and keep decrypting under
`INTEGRATION_ENCRYPTION_KEY`. Every read goes through `getCredential`, which
enforces the credential's scope grants and writes a hash-chained row to
`credential_access_log`.

| Variable | Meaning |
|----------|---------|
| `KEYCHAIN_KMS` | `local-file` or `aws-kms`. Read once at start; any other value stops the server. Unset means `local-file` outside production and an error on first use in production. |
| `KEYCHAIN_LOCAL_KEK_FILE` | `local-file` only. Default `.data/keychain-kek`. Created with 600 permissions on first use. Lose it and every credential wrapped under it is unrecoverable. `.data/` is gitignored. |
| `AWS_REGION` | `aws-kms` only. `eu-central-1` in production. Credentials come from the standard AWS provider chain. |

Develop on `KEYCHAIN_KMS=local-file`. CI never calls AWS; the KMS tests use a mocked client.

**Least-privilege policy for the runtime identity** (`aws-kms`). The first write for
a workspace creates its key and the alias `alias/maskin-keychain-<workspaceId>`, so the
runtime needs `CreateKey` and `TagResource` as well as `CreateAlias`. IAM authorises
key operations against the key, not its alias, so use of the keys is limited by the
`kms:ResourceAliases` condition. Replace `ACCOUNT_ID`. This sample has not been run
against a live account: Infra validates it in staging before production.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KeychainCreateKey",
      "Effect": "Allow",
      "Action": ["kms:CreateKey", "kms:TagResource"],
      "Resource": "*"
    },
    {
      "Sid": "KeychainCreateAlias",
      "Effect": "Allow",
      "Action": "kms:CreateAlias",
      "Resource": [
        "arn:aws:kms:eu-central-1:ACCOUNT_ID:alias/maskin-keychain-*",
        "arn:aws:kms:eu-central-1:ACCOUNT_ID:key/*"
      ]
    },
    {
      "Sid": "KeychainUseKeys",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:eu-central-1:ACCOUNT_ID:key/*",
      "Condition": {
        "ForAnyValue:StringLike": { "kms:ResourceAliases": "alias/maskin-keychain-*" }
      }
    },
    {
      "Sid": "KeychainNeverDestroy",
      "Effect": "Deny",
      "Action": ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"],
      "Resource": "*"
    }
  ]
}
```

`kms:CreateKey` does not support resource scoping, hence `"Resource": "*"`. The key
policy on each key must keep a human-held administrator principal as break-glass.

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
