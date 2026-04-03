# Integration Provider Conventions

## Adding a New OAuth2 Provider

### 1. Create the provider directory

```
apps/dev/src/lib/integrations/providers/{provider-name}/
  config.ts        ← required: ProviderConfig
  auth.ts          ← only if using oauth2_custom
  webhooks.ts      ← only if webhook normalization is complex
```

### 2. Copy from the template

Start from `providers/_template/config.ts` and fill in:
- `name`: lowercase kebab-case (e.g., `'google-calendar'`)
- `displayName`: human-readable (e.g., `'Google Calendar'`)
- `auth.config`: authorization URL, token URL, scopes, env var names for client ID/secret
- `webhook`: only if the provider sends webhooks
- `events`: event definitions and optional declarative mapping
- `mcp`: only if an MCP server exists for this provider

### 3. Register in `registry.ts`

Import the config and add it to the providers map:

```typescript
import { config as providerConfig } from './providers/provider-name/config'

providers.set('provider-name', {
  config: providerConfig,
})
```

If the provider has custom token parsing:

```typescript
import { config as providerConfig, parseTokenResponse } from './providers/provider-name/config'

providers.set('provider-name', {
  config: providerConfig,
  parseTokenResponse,
})
```

### 4. Add environment variables

Document the required env vars in the provider's config.ts comments and add them to `.env.example`:
- `{PROVIDER}_CLIENT_ID`
- `{PROVIDER}_CLIENT_SECRET`
- `{PROVIDER}_WEBHOOK_SECRET` (if webhooks are used)

## Auth Types

| Type | When to use | What to implement |
|------|------------|-------------------|
| `oauth2` | Standard OAuth2 providers (Slack, Google, Linear, etc.) | Just the config — framework handles the flow |
| `oauth2_custom` | Non-standard auth (GitHub Apps, providers with JWT signing) | Export `CustomAuthHandler` in `auth.ts` |
| `api_key` | API key-based integrations | Just the config with `headerName` and `envKeyName` |

## Provider Quirks

Handle provider-specific behavior through these escape hatches:

1. **Extra auth params**: Use `extraAuthParams` (e.g., `{ access_type: 'offline' }` for Google)
2. **Non-standard token response**: Export `parseTokenResponse` function from config
3. **Custom webhook verification**: Set `webhook: { type: 'custom' }` and handle in normalizer
4. **Fully custom auth**: Use `auth: { type: 'oauth2_custom' }` and implement `CustomAuthHandler`
5. **Webhook matching**: If the provider sends webhooks via standard OAuth2, export `resolveExternalId` — called once during callback to get a stable ID (e.g., `team_id`) that matches what `extractInstallationId()` finds in webhook payloads

## File Locations

| File | Purpose |
|------|---------|
| `apps/dev/src/lib/integrations/types.ts` | Core types (ProviderConfig, StoredCredentials, etc.) |
| `apps/dev/src/lib/integrations/registry.ts` | Provider registration |
| `apps/dev/src/lib/integrations/oauth/handler.ts` | Generic OAuth2 flow |
| `apps/dev/src/lib/integrations/oauth/token-manager.ts` | Token lifecycle (lazy refresh) |
| `apps/dev/src/lib/integrations/webhooks/handler.ts` | Webhook signature verification |
| `apps/dev/src/lib/integrations/events/normalizer.ts` | Event normalization |
| `apps/dev/src/lib/integrations/providers/` | Provider configs |
| `apps/dev/src/routes/integrations.ts` | Route handlers |

## Testing

When adding a new provider:
- Unit test the config loads correctly (provider appears in `listProviders()`)
- If custom auth: test `getInstallUrl()`, `handleCallback()`, `getAccessToken()`
- If custom normalizer: test event normalization with sample payloads
- Test location: `apps/dev/src/__tests__/lib/integrations/providers/{provider}.test.ts`
