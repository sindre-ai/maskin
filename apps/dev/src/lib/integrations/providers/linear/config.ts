import type { ProviderConfig, StoredCredentials } from '../../types'

export const config: ProviderConfig = {
	name: 'linear',
	displayName: 'Linear',

	auth: {
		type: 'oauth2',
		config: {
			authorizationUrl: 'https://linear.app/oauth/authorize',
			tokenUrl: 'https://api.linear.app/oauth/token',
			revokeUrl: 'https://api.linear.app/oauth/revoke',
			scopes: ['read', 'write', 'issues:create', 'comments:create'],
			pkce: true,
			clientIdEnv: 'LINEAR_CLIENT_ID',
			clientSecretEnv: 'LINEAR_CLIENT_SECRET',
		},
	},

	webhook: {
		signatureHeader: 'linear-signature',
		signatureScheme: 'hmac-sha256',
		secretEnv: 'LINEAR_WEBHOOK_SECRET',
	},

	events: {
		definitions: [
			{
				entityType: 'linear.issue',
				actions: ['create', 'update', 'remove'],
				label: 'Issue',
			},
			{
				entityType: 'linear.comment',
				actions: ['create', 'update', 'remove'],
				label: 'Comment',
			},
			{
				entityType: 'linear.project',
				actions: ['create', 'update', 'remove'],
				label: 'Project',
			},
			{
				entityType: 'linear.cycle',
				actions: ['create', 'update', 'remove'],
				label: 'Cycle',
			},
			{
				entityType: 'linear.label',
				actions: ['create', 'update', 'remove'],
				label: 'Label',
			},
			{
				entityType: 'linear.project_update',
				actions: ['create', 'update', 'remove'],
				label: 'Project Update',
			},
			{
				entityType: 'linear.reaction',
				actions: ['create', 'remove'],
				label: 'Reaction',
			},
		],
	},

	mcp: {
		command: 'npx',
		args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp'],
		envKey: 'LINEAR_API_KEY',
	},
}

/**
 * Resolve the Linear organization ID for webhook matching.
 * Calls the GraphQL API to get organization.id, which matches
 * the organizationId field in webhook payloads.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	const res = await fetch('https://api.linear.app/graphql', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${credentials.accessToken}`,
		},
		body: JSON.stringify({ query: '{ organization { id } }' }),
	})
	if (!res.ok) {
		throw new Error(`Failed to resolve Linear organization ID: HTTP ${res.status}`)
	}
	const data = (await res.json()) as {
		data?: { organization?: { id?: string } }
		errors?: unknown[]
	}
	const orgId = data.data?.organization?.id
	if (!orgId) {
		throw new Error(
			`Failed to resolve Linear organization ID: ${JSON.stringify(data.errors ?? 'no organization found')}`,
		)
	}
	return orgId
}
