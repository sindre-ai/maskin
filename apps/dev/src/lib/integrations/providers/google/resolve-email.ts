import type { StoredCredentials } from '../../types'

/**
 * Resolve the connected Google account's email address via the userinfo endpoint.
 * Shared by Gmail and Google Calendar — both use the same OAuth2 server and response shape.
 */
export const resolveGoogleEmail = async (credentials: StoredCredentials, label: string): Promise<string> => {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${credentials.accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve ${label} email: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { email?: string }
	if (!data.email) {
		throw new Error(`${label} userinfo response missing email field`)
	}
	return data.email
}
