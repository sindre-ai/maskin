import { resolveGoogleEmail } from '../google/resolve-email'
import type { StoredCredentials } from '../../types'

/**
 * Resolve the Gmail user's email address as the integration's externalId.
 *
 * Pub/Sub push payloads decode to `{ emailAddress, historyId }`, so matching the
 * webhook to an integration row requires `integrations.external_id === emailAddress`.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	return resolveGoogleEmail(credentials, 'Gmail')
}
