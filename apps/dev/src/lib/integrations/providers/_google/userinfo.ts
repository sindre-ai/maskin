/**
 * Shared helper for resolving the connected Google account email via the
 * OAuth2 v2 userinfo endpoint. Used by both Gmail and Google Calendar so a
 * single location needs updating if the endpoint changes.
 */
export async function resolveGoogleEmail(accessToken: string): Promise<string> {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Google account email: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { email?: string }
	if (!data.email) {
		throw new Error('Google userinfo response missing email field')
	}
	return data.email
}
