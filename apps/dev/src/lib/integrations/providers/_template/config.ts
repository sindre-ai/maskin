/**
 * Integration Provider Template
 *
 * Copy this file to a new directory under providers/ and fill in the values.
 * For most OAuth2 providers, this config file is all you need.
 *
 * Directory structure for a new provider:
 *   providers/
 *     your-provider/
 *       config.ts          ← this file (required)
 *       auth.ts            ← only if auth.type is 'oauth2_custom'
 *       webhooks.ts        ← only if webhook normalization is complex
 *
 * After creating the config, register it in registry.ts.
 */
import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'provider-name', // lowercase, kebab-case, unique key
	displayName: 'Provider Name', // human-readable name

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://provider.com/oauth/authorize',
			tokenUrl: 'https://provider.com/oauth/token',
			// refreshUrl: 'https://provider.com/oauth/token', // defaults to tokenUrl
			// revokeUrl: 'https://provider.com/oauth/revoke',
			scopes: ['scope1', 'scope2'],
			// pkce: false,
			// tokenAuthMethod: 'client_secret_post', // or 'client_secret_basic'
			// extraAuthParams: { access_type: 'offline' }, // e.g. Google offline access
			// extraTokenParams: {},
			clientIdEnv: 'PROVIDER_CLIENT_ID',
			clientSecretEnv: 'PROVIDER_CLIENT_SECRET',
		},
	},

	// Uncomment if the provider sends webhooks (HMAC-based):
	// webhook: {
	//   signatureHeader: 'x-provider-signature',
	//   signatureScheme: 'hmac-sha256',
	//   signaturePrefix: 'sha256=',
	//   secretEnv: 'PROVIDER_WEBHOOK_SECRET',
	//   eventTypeHeader: 'x-provider-event',
	// },

	// Alternative: timestamp-based signature (e.g. Slack-style):
	// webhook: {
	//   signatureHeader: 'x-provider-signature',    // not used for timestamp scheme, but required by type
	//   signatureScheme: 'timestamp',
	//   secretEnv: 'PROVIDER_SIGNING_SECRET',
	//   timestampHeader: 'x-provider-request-timestamp',
	//   timestampSignatureHeader: 'x-provider-signature',
	//   timestampBodyTemplate: 'v0:{timestamp}:{body}',
	//   timestampSignaturePrefix: 'v0=',
	// },

	// Uncomment if defining events:
	// events: {
	//   definitions: [
	//     {
	//       entityType: 'provider.resource',
	//       actions: ['created', 'updated', 'deleted'],
	//       label: 'Resource',
	//     },
	//   ],
	//   // For simple providers, use declarative mapping instead of a custom normalizer:
	//   mapping: {
	//     'resource.created': { entityType: 'provider.resource', action: 'created' },
	//     'resource.updated': { entityType: 'provider.resource', action: 'updated' },
	//   },
	// },

	// Uncomment if an MCP server exists for this provider:
	// mcp: {
	//   command: 'npx',
	//   args: ['-y', '@some-org/mcp-server-provider'],
	//   envKey: 'PROVIDER_ACCESS_TOKEN',
	// },
}

// Optional: override token response parsing for non-standard providers.
// For example, if the provider nests the access token differently:
//
// import type { StoredCredentials } from '../../types'
// export const parseTokenResponse = (raw: unknown): Partial<StoredCredentials> => {
//   const data = raw as Record<string, unknown>
//   return {
//     accessToken: data.access_token as string,
//     refreshToken: data.refresh_token as string | undefined,
//   }
// }
