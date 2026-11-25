/**
 * What Google's own token check says about the token Maskin sent a Google-hosted MCP server
 * that refused it. Only for the refusal log line: it tells a dead token (the check fails) from a
 * live one issued to the wrong client or lacking scopes. The token itself is never returned or logged.
 */

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const CHECK_TIMEOUT_MS = 3_000
/** At most one check per connection per minute, so a retry loop cannot flood Google. */
const MIN_INTERVAL_MS = 60_000
const MAX_TRACKED = 500

const lastCheckAt = new Map<string, number>()

export type GoogleTokenCheck =
	| { checked: false; reason: 'not_google' | 'no_token' | 'rate_limited' }
	| {
			checked: true
			valid: true
			clientId: string | null
			scopes: string[]
			secondsLeft: number | null
	  }
	| { checked: true; valid: false; error: string }

export function isGoogleApisUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname
		return host === 'googleapis.com' || host.endsWith('.googleapis.com')
	} catch {
		return false
	}
}

function bearerToken(authorization: string | undefined): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
	return match?.[1] ?? null
}

export async function checkGoogleToken(args: {
	connectionKey: string
	upstreamUrl: string
	authorization: string | undefined
	now?: number
}): Promise<GoogleTokenCheck> {
	if (!isGoogleApisUrl(args.upstreamUrl)) return { checked: false, reason: 'not_google' }
	const token = bearerToken(args.authorization)
	if (!token) return { checked: false, reason: 'no_token' }

	const now = args.now ?? Date.now()
	const last = lastCheckAt.get(args.connectionKey)
	if (last !== undefined && now - last < MIN_INTERVAL_MS) {
		return { checked: false, reason: 'rate_limited' }
	}
	if (lastCheckAt.size >= MAX_TRACKED && !lastCheckAt.has(args.connectionKey)) {
		const oldest = lastCheckAt.keys().next().value
		if (oldest !== undefined) lastCheckAt.delete(oldest)
	}
	lastCheckAt.set(args.connectionKey, now)

	// The token goes in the POST body, not the URL, so it cannot end up in a request log.
	const scrub = (text: string) => text.split(token).join('[token]').slice(0, 200)
	try {
		const res = await fetch(TOKENINFO_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ access_token: token }),
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		})
		const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
		if (!res.ok || !body) {
			const reason =
				typeof body?.error_description === 'string'
					? body.error_description
					: typeof body?.error === 'string'
						? body.error
						: `HTTP ${res.status}`
			return { checked: true, valid: false, error: scrub(reason) }
		}
		const clientId =
			typeof body.azp === 'string' ? body.azp : typeof body.aud === 'string' ? body.aud : null
		const secondsLeft = Number(body.expires_in)
		return {
			checked: true,
			valid: true,
			clientId,
			scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
			secondsLeft: Number.isFinite(secondsLeft) ? secondsLeft : null,
		}
	} catch (err) {
		return {
			checked: true,
			valid: false,
			error: scrub(err instanceof Error ? err.name : 'unknown'),
		}
	}
}

/** Test seam. */
export function clearGoogleTokenCheckThrottle(): void {
	lastCheckAt.clear()
}
