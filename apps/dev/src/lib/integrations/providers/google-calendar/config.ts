import type { ProviderConfig } from '../../types'

/**
 * Google Calendar integration via standard OAuth2.
 *
 * Scopes are deliberately split — `calendar.readonly` for list/free-busy and
 * `calendar.events` for create/update/RSVP — instead of the broader `calendar`
 * scope, so the consent screen shows exactly what we use and revoking write
 * access (or future audit) can dial blast-radius down to read-only.
 *
 * MCP wiring uses Google's hosted MCP server at calendarmcp.googleapis.com,
 * but agents route it through the container-local tool-invocation emitter
 * (`/opt/maskin/mcp-tool-invocation-emitter.mjs` → `mcp-remote` → hosted MCP)
 * so every tool call fires a PostHog `mcp_tool_invocation` — the event this bet's
 * ship metric reads. The `mcp.command`/`args` below mirror the frontend preset
 * in `apps/web/src/components/agents/mcp-servers.tsx` (kept in sync manually —
 * see `.claude/rules/integrations.md`). The backend `mcp.envKey` tells
 * session-manager which env var to inject the access token as; no second OAuth
 * flow inside the container.
 */
export const config: ProviderConfig = {
	name: 'google-calendar',
	displayName: 'Google Calendar',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenUrl: 'https://oauth2.googleapis.com/token',
			revokeUrl: 'https://oauth2.googleapis.com/revoke',
			scopes: [
				'https://www.googleapis.com/auth/calendar.readonly',
				'https://www.googleapis.com/auth/calendar.events',
				'https://www.googleapis.com/auth/userinfo.email',
				'openid',
			],
			pkce: true,
			// access_type=offline + prompt=consent are the documented way to force
			// Google to issue a refresh_token. Without them only the first connect
			// for a given (user, client) pair gets one.
			extraAuthParams: {
				access_type: 'offline',
				prompt: 'consent',
				include_granted_scopes: 'true',
			},
			clientIdEnv: 'GOOGLE_CALENDAR_CLIENT_ID',
			clientSecretEnv: 'GOOGLE_CALENDAR_CLIENT_SECRET',
		},
	},

	mcp: {
		command: 'node',
		args: [
			'/opt/maskin/mcp-tool-invocation-emitter.mjs',
			'https://calendarmcp.googleapis.com/mcp/v1',
		],
		envKey: 'GOOGLE_CALENDAR_TOKEN',
	},

	externalIdDisplay: 'email',
}
