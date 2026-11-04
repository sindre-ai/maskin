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
 * Fetch the caller's Google People id via `people.get(me)`. `openid` alone
 * grants this read. The id is the first entry of `metadata.sources[]` — a
 * numeric string that is stable for the life of the Google account.
 */
export async function resolveGooglePeopleId(accessToken: string): Promise<string> {
	const res = await fetch('https://people.googleapis.com/v1/people/me?personFields=metadata', {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Failed to resolve Google People id: HTTP ${res.status} ${text}`)
	}
	const data = (await res.json()) as { metadata?: { sources?: Array<{ id?: string }> } }
	const peopleId = data.metadata?.sources?.[0]?.id
	if (!peopleId) {
		throw new Error('Google People response missing metadata.sources[0].id')
	}
	return peopleId
}
