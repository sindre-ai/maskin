import type { IntegrationResponse } from '@/lib/api'
import { GOOGLE_FAMILY_PROVIDERS } from '@/lib/drive-humans'

export type DriveDisconnectScope = 'drive' | 'drive-meet' | 'google'

/** Providers each radio removes. Mirrors GOOGLE_DISCONNECT_SCOPES on the backend,
 *  which is what actually decides; this only predicts the result for the copy. */
const REMOVED_BY_SCOPE: Record<DriveDisconnectScope, readonly string[]> = {
	drive: ['google-drive'],
	'drive-meet': ['google-drive', 'google-meet'],
	google: GOOGLE_FAMILY_PROVIDERS,
}

const SERVICE_LABEL: Record<string, string> = {
	gmail: 'Gmail',
	'google-calendar': 'Calendar',
	'google-meet': 'Meet',
	'google-drive': 'Drive',
}

/** "Gmail, Calendar and Meet". Empty for no services. */
export function joinServices(providers: readonly string[]): string {
	const labels = providers.map((p) => SERVICE_LABEL[p] ?? p)
	if (labels.length <= 1) return labels.join('')
	return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** The human's connected Google-family providers, in display order, read from
 *  the rows that exist. A provider the human has no live row for is absent. */
export function connectedGoogleProviders(
	integrations: IntegrationResponse[],
	email: string,
): string[] {
	const live = new Set(
		integrations
			.filter(
				(row) =>
					(GOOGLE_FAMILY_PROVIDERS as readonly string[]).includes(row.provider) &&
					row.externalId?.toLowerCase() === email.toLowerCase() &&
					(row.status === 'active' || row.status === 'error'),
			)
			.map((row) => row.provider),
	)
	return GOOGLE_FAMILY_PROVIDERS.filter((p) => live.has(p))
}

/** What stays connected after removing the chosen radio's providers. */
export function remainingProviders(
	connected: readonly string[],
	scope: DriveDisconnectScope,
): string[] {
	return connected.filter((p) => !REMOVED_BY_SCOPE[scope].includes(p))
}
