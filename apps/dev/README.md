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

### LinkedIn — Unipile Hosted Auth Wizard

See the technical spec in the parent bet
(**First-party LinkedIn MCP — Unipile-backed, customer-auth**) and the
provider directory at
`apps/dev/src/lib/integrations/providers/linkedin-unipile/`.

- **UNIPILE_BASE_URL** — Unipile REST API base
  (e.g. `https://api8.unipile.com:XXXX`). No trailing slash.
- **UNIPILE_API_KEY** — the workspace-agnostic Maskin-owned API key sent as
  `X-API-KEY` on every Unipile request.
- **UNIPILE_WEBHOOK_SECRET** — shared secret used to HMAC-SHA256 verify the
  `/api/integrations/linkedin-unipile/callback` payload Unipile POSTs on
  hosted-wizard completion. Set the same value in the Unipile partnerships
  dashboard.
- **MASKIN_PUBLIC_URL** — public base URL of this API instance; used to
  build the callback URL passed to Unipile at hosted-link-creation time
  (`{MASKIN_PUBLIC_URL}/api/integrations/linkedin-unipile/callback`).
  Defaults to `http://localhost:3000` when unset.

Callback URLs to register with Unipile partnerships as the notify-URL:

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
