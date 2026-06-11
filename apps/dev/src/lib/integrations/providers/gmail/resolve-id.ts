import type { StoredCredentials } from '../../types'

/**
 * Resolve the Gmail user's email address as the integration's externalId.
 *
 * Pub/Sub push payloads decode to `{ emailAddress, historyId }`, so matching the
 * webhook to an integration row requires `integrations.external_id === emailAddress`.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${credentials.accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Gmail email: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { email?: string }
	if (!data.email) {
		throw new Error('Gmail userinfo response missing email field')
	}
	return data.email
}
