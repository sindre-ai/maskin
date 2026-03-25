export interface IntegrationCredentials {
	installation_id: string
	[key: string]: unknown
}

export interface NormalizedEvent {
	entityType: string
	action: string
	installationId: string
	data: Record<string, unknown>
}

export interface EventDefinition {
	entityType: string
	actions: string[]
	label: string
}

export interface IntegrationProvider {
	name: string
	displayName: string

	// Installation flow
	getInstallUrl(state: string): string
	handleCallback(params: Record<string, string>): Promise<IntegrationCredentials>

	// Webhooks
	verifyWebhook(body: string, signature: string): boolean
	normalizeEvent(payload: unknown, headers: Record<string, string>): NormalizedEvent | null
	getAvailableEvents(): EventDefinition[]

	// Agent tools — generate a short-lived access token for MCP server
	getAccessToken(credentials: IntegrationCredentials): Promise<string>

	// MCP server command to spawn for this provider
	getMcpCommand(): { command: string; args: string[]; envKey: string }
}
