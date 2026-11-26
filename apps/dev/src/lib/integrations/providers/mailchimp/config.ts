import type { ProviderConfig } from '../../types'

/**
 * Mailchimp, through its hosted MCP server (https://ai-inc.mailchimp.com/claude/mcp/v2). The authorize and token URLs below are
 * from the sign-in details the server publishes at ai-inc.mailchimp.com/.well-known/oauth-authorization-server/claude (checked 20 Nov 2026).
 *
 * The client is registered once for Maskin's callback (`/api/integrations/mailchimp/callback` on each
 * public origin) through Mailchimp's open registration (RFC 7591, scripts/register-oauth-client.mjs mailchimp https://ai-inc.mailchimp.com/.well-known/oauth-authorization-server/claude); a public client with PKCE and no secret, so only MAILCHIMP_CLIENT_ID is set (register with --auth-method none).
 *
 * LOW CONFIDENCE: this is the server Mailchimp built as its Claude connector (the /claude path); its docs do not say other clients are accepted. Treat it as unproven until a real sign-in works, and drop it if registration or sign-in is refused.
 *
 * A read-only agent stays read-only at the MCP gateway (GATEWAY_PROVIDERS). Tools carry no curated
 * read list: they are classified from the server's own annotations and names, and an unknown tool
 * is a write.
 */
export const config: ProviderConfig = {
	name: 'mailchimp',
	displayName: 'Mailchimp',
	description: 'Read Mailchimp audiences, campaigns and reports through the Mailchimp MCP',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://ai-inc.mailchimp.com/claude/oauth/authorize',
			tokenUrl: 'https://ai-inc.mailchimp.com/claude/oauth/token',
			scopes: ['mailchimp'],
			pkce: true,
			tokenAuthMethod: 'none',
			clientIdEnv: 'MAILCHIMP_CLIENT_ID',
		},
	},

	// No webhook or events block: data is read on demand through the MCP.

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://ai-inc.mailchimp.com/claude/mcp/v2'],
		envKey: 'MAILCHIMP_TOKEN',
		server: {
			type: 'http',
			url: 'https://ai-inc.mailchimp.com/claude/mcp/v2',
			headers: { Authorization: 'Bearer ${MAILCHIMP_TOKEN}' },
		},
	},
}
