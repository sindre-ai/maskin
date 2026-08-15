import type { ProviderConfig } from '../../types'

/**
 * Skjald has no central app and no outbound-callable API — every desktop
 * install mints its own webhook secret locally. `auth.type: 'manual'` means
 * Maskin invents the credential handshake itself (see routes/integrations.ts
 * `/connect` + `/complete` for the manual-auth branch) instead of consuming
 * an OAuth token or a pasted API key.
 *
 * No `webhook` field: the generic single-secret verifier in
 * webhooks/handler.ts can't check a per-integration secret. Skjald deliveries
 * go through the dedicated `webhookApp.post('/skjald/:token', ...)` route,
 * which looks up the per-row secret and calls `verifyTimestampSignature()`
 * directly instead of going through the provider dispatcher.
 */
export const config: ProviderConfig = {
	name: 'skjald',
	displayName: 'Skjald',
	description: 'Local meeting notetaker — finished meetings sync in as meeting objects',

	auth: {
		type: 'manual',
	},

	events: {
		definitions: [
			{
				entityType: 'meeting',
				actions: ['created', 'updated'],
				label: 'Meeting',
			},
		],
	},
}
