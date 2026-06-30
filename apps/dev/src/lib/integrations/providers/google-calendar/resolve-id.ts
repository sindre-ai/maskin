import type { StoredCredentials } from '../../types'
import { resolveGoogleEmail } from '../google/resolve-email'

/**
 * Resolve the connected Google account's email address as the integration's
 * externalId. Stable per Google account and human-readable in the admin UI.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	return resolveGoogleEmail(credentials, 'Google Calendar')
}
