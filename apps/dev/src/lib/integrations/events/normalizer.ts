import type { NormalizedEvent, ResolvedProvider, WebhookConfig } from '../types'

/**
 * Normalize a webhook payload into a standard event.
 *
 * Uses the provider's custom normalizer if available, otherwise falls back
 * to declarative event mapping from the provider config.
 */
export function normalizeEvent(
	provider: ResolvedProvider,
	payload: unknown,
	headers: Record<string, string>,
): NormalizedEvent | null {
	// Custom normalizer takes priority (for complex providers like GitHub)
	if (provider.customNormalizer) {
		return provider.customNormalizer(payload, headers)
	}

	// Declarative mapping
	const mapping = provider.config.events?.mapping
	if (!mapping) return null

	const webhookConfig = provider.config.webhook
	if (!webhookConfig || 'type' in webhookConfig) return null

	const eventType = getEventType(webhookConfig, headers)
	const body = payload as Record<string, unknown>
	const action = (body.action as string) || ''

	// Try exact match first (e.g. 'pull_request.opened')
	const key = action ? `${eventType}.${action}` : eventType
	const mapped = mapping[key] ?? mapping[eventType]
	if (!mapped) return null

	// Try to extract installation/account ID from common payload locations
	const installationId = extractInstallationId(body)
	if (!installationId) return null

	return {
		entityType: mapped.entityType,
		action: mapped.action,
		installationId,
		data: body,
	}
}

function getEventType(config: WebhookConfig, headers: Record<string, string>): string {
	if (config.eventTypeHeader) {
		return headers[config.eventTypeHeader] || ''
	}
	return ''
}

/** Extract installation/account ID from common webhook payload structures */
function extractInstallationId(body: Record<string, unknown>): string {
	// GitHub-style: body.installation.id
	const installation = body.installation as Record<string, unknown> | undefined
	if (installation?.id) return String(installation.id)

	// Generic: body.account_id or body.team_id
	if (typeof body.account_id === 'string') return body.account_id
	if (typeof body.team_id === 'string') return body.team_id

	return ''
}
