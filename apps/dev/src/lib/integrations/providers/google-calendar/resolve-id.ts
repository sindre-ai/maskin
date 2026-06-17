import type { StoredCredentials } from '../../types'

/**
 * Use the connecting user's email address as the integration's externalId.
 *
 * Calendar push notifications don't carry the user identity in headers (only
 * a channel id and our chosen token). We pin externalId to the email and
 * encode the same email back into the channel token at watch-creation, so
 * the webhook route's installationId → externalId match still works.
 */
export const resolveExternalId = async (credentials: StoredCredentials): Promise<string> => {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${credentials.accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Google Calendar email: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { email?: string }
	if (!data.email) {
		throw new Error('Google userinfo response missing email field')
	}
	return data.email
}
