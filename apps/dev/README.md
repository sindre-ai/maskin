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

### LinkedIn — Unipile Hosted Auth v2

See the technical spec in the parent bet
(**First-party LinkedIn MCP — Unipile-backed, customer-auth**) and the
provider directory at
`apps/dev/src/lib/integrations/providers/linkedin-unipile/`.

- **UNIPILE_BASE_URL** — Unipile v2 REST API base. Docs default is
  `https://api.unipile.com`; a tenant may issue a tenant-subdomain host
  instead. The value must NOT include the `/v2` path suffix — the client
  concatenates the path. No trailing slash. See
  https://developer.unipile.com/v2.0/docs.
- **UNIPILE_API_KEY** — the workspace-agnostic Maskin-owned API key sent as
  `X-API-KEY` on every Unipile request.
- **UNIPILE_WEBHOOK_SECRET** — retained for future account-status webhooks
  (https://developer.unipile.com/v2.0/docs/webhooks-introduction). v2
  hosted-auth does NOT consume this — the callback is a GET redirect whose
  auth is the unguessable `state` round-trip binding, not HMAC.
- **MASKIN_PUBLIC_URL** — public base URL of this API instance. Passed to
  Unipile v2 as `redirect_uri` at auth-link creation time
  (`{MASKIN_PUBLIC_URL}/api/integrations/linkedin-unipile/callback`) and
  used to build the post-callback redirect back to Settings > Integrations.
  Defaults to `http://localhost:3000` when unset.

Callback URLs to register with Unipile partnerships as `redirect_uri`
allowlist entries on the v2 hosted-auth application:

- Prod: `https://api.maskin.io/api/integrations/linkedin-unipile/callback`
- Dev:  `https://api.dev.maskin.io/api/integrations/linkedin-unipile/callback`

## Tests

```
pnpm --filter @maskin/dev test
```

Unit tests live under `src/__tests__/`. The Vitest suite is fully offline —
no live Unipile / LinkedIn / Slack calls are made. See
`src/lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server.ts`
for the in-process Unipile mock server used by the LinkedIn tests.
