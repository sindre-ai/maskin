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

/**
 * Resolve the caller's stable Google account id (the "People id") from the
 * OAuth2 v2 userinfo endpoint's `id` (the OIDC `sub`). It is the same numeric
 * string `people/me` reports in `metadata.sources[].id`, and it is stable for
 * the life of the Google account.
 *
 * We do NOT call the People API: it is a separate Cloud API that can answer
 * 403 for a fresh account (Meet hit this, Sentry MASKIN-DEV-11), and no scope
 * fixes that. Userinfo needs nothing beyond the `openid` + `userinfo.email`
 * scopes already granted.
 */
export async function resolveGooglePeopleId(accessToken: string): Promise<string> {
	const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Google People id: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { id?: string }
	if (!data.id) {
		throw new Error('Google userinfo response missing id field')
	}
	return data.id
}
