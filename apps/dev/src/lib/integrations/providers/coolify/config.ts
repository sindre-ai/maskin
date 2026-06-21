import type { ProviderConfig } from '../../types'

export const config: ProviderConfig = {
	name: 'coolify',
	displayName: 'Coolify',
	description:
		'Coolify infra-layer observability. Deployment, application, and health-check webhooks land as urgent workspace insights.',

	// API-key auth so a workspace can pair its Coolify install without an OAuth round-trip.
	// The platform-wide webhook secret (COOLIFY_WEBHOOK_SECRET) is what verifies inbound
	// payloads; the per-workspace credential just marks the integration row as active.
	auth: {
		type: 'api_key',
		config: {
			headerName: 'Authorization',
			headerPrefix: 'Bearer ',
		},
	},

	// Webhooks land on the dedicated /api/webhooks-coolify route (creates insights, not
	// events). No entry under `webhook` here — the generic /api/webhooks/:provider path
	// would normalize into the events table, which is not the shape T3's immediate-triage
	// trigger reads.

	events: {
		definitions: [
			{
				entityType: 'coolify.deployment',
				actions: ['failed'],
				label: 'Deployment',
			},
			{
				entityType: 'coolify.application',
				actions: ['crashed', 'health_check_failed'],
				label: 'Application',
			},
		],
	},
}
