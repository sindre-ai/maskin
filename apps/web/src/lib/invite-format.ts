const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

// Same shape as the backend's email schema accepts: something@something.tld.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidInviteEmail(value: string): boolean {
	return EMAIL_PATTERN.test(value.trim())
}

export function inviteRoleLabel(role: string): string {
	return role.charAt(0).toUpperCase() + role.slice(1)
}

/**
 * "expires in 4h" — only once less than 24h remain; null before that so the
 * pending row stays quiet for most of an invite's seven days.
 */
export function formatInviteExpiry(expiresAt: string, now = Date.now()): string | null {
	const remaining = new Date(expiresAt).getTime() - now
	if (remaining >= 24 * HOUR_MS) return null
	if (remaining >= HOUR_MS) return `expires in ${Math.floor(remaining / HOUR_MS)}h`
	return `expires in ${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`
}

/** "about 4 hours" / "about 1 minute" from a Retry-After seconds value. */
export function formatRetryAfter(seconds: number | undefined): string | null {
	if (!seconds || seconds <= 0) return null
	const hours = Math.round(seconds / 3600)
	if (hours >= 1) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`
	const minutes = Math.max(1, Math.round(seconds / 60))
	return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}
