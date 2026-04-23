import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'github',
	displayName: 'GitHub',
	description: 'GitHub App integration for repositories, pull requests, issues, and more',

	auth: { type: 'oauth2_custom' },

	webhook: {
		signatureHeader: 'x-hub-signature-256',
		signatureScheme: 'hmac-sha256',
		signaturePrefix: 'sha256=',
		secretEnv: 'GITHUB_APP_WEBHOOK_SECRET',
		eventTypeHeader: 'x-github-event',
	},

	events: {
		definitions: [
			{
				entityType: 'github.pull_request',
				actions: ['opened', 'closed', 'synchronize', 'review_requested', 'merged'],
				label: 'Pull Request',
			},
			{
				entityType: 'github.issue',
				actions: ['opened', 'closed', 'labeled', 'assigned'],
				label: 'Issue',
			},
			{
				entityType: 'github.push',
				actions: ['pushed'],
				label: 'Push',
			},
			{
				entityType: 'github.review',
				actions: ['submitted', 'dismissed'],
				label: 'Pull Request Review',
			},
		],
	},

	mcp: {
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		envKey: 'GITHUB_TOKEN',
	},
}
