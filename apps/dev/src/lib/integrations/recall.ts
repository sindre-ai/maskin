import type {
	EventDefinition,
	IntegrationCredentials,
	IntegrationProvider,
	NormalizedEvent,
} from './types'

const RECALL_EVENTS: EventDefinition[] = [
	{
		entityType: 'recall.bot.status_change',
		actions: ['status_change'],
		label: 'Bot Status Change',
	},
	{
		entityType: 'recall.bot.done',
		actions: ['done'],
		label: 'Bot Recording Complete',
	},
]

export class RecallIntegrationProvider implements IntegrationProvider {
	name = 'recall'
	displayName = 'Recall.ai'

	getInstallUrl(state: string): string {
		const baseUrl = process.env.BETTER_AUTH_URL || 'http://localhost:5173'
		return `${baseUrl}/settings/integrations?connect=recall&state=${encodeURIComponent(state)}`
	}

	async handleCallback(params: Record<string, string>): Promise<IntegrationCredentials> {
		const apiKey = params.api_key
		if (!apiKey) throw new Error('Missing api_key parameter')

		// Validate the API key by calling Recall API
		const response = await fetch('https://us-west-2.recall.ai/api/v1/bot/', {
			method: 'GET',
			headers: { Authorization: `Token ${apiKey}` },
		})
		if (!response.ok) throw new Error('Invalid Recall.ai API key')

		return { installation_id: 'recall', api_key: apiKey }
	}

	verifyWebhook(_body: string, _signature: string): boolean {
		// Recall uses Svix webhook verification
		// TODO: Implement Svix HMAC-SHA256 verification using RECALL_WEBHOOK_SECRET
		return true
	}

	normalizeEvent(payload: unknown, _headers: Record<string, string>): NormalizedEvent | null {
		const data = payload as Record<string, unknown>
		const event = data.event as string
		if (!event) return null

		return {
			entityType: `recall.${event}`,
			action: event,
			installationId: 'recall',
			data: (data.data as Record<string, unknown>) ?? {},
		}
	}

	getAvailableEvents(): EventDefinition[] {
		return RECALL_EVENTS
	}

	async getAccessToken(credentials: IntegrationCredentials): Promise<string> {
		return (credentials as unknown as { api_key: string }).api_key
	}

	getMcpCommand(): { command: string; args: string[]; envKey: string } {
		return { command: '', args: [], envKey: 'RECALL_API_KEY' }
	}
}
