import crypto from 'node:crypto'

// HMAC-signed payload carried on the `maskin_guest` HttpOnly cookie. The
// cookie binds a landing-page visitor to a stable `guestSessionId` so that
// the throttle (3 drafts per cookie) and the signup → draft handoff (T7
// will read this id) survive across requests without a server-side session
// table.

const COOKIE_NAME = 'maskin_guest'
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days — outlives the throttle window
const ID_BYTES = 16

export const GUEST_COOKIE_NAME = COOKIE_NAME

export function getGuestSessionSecret(): string {
	const secret = process.env.GUEST_SESSION_SECRET
	if (!secret || secret.length < 32) {
		throw new Error(
			'GUEST_SESSION_SECRET must be set to a string of at least 32 characters before serving guest traffic',
		)
	}
	return secret
}

function sign(payload: string, secret: string): string {
	return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signGuestSessionId(
	guestSessionId: string,
	secret = getGuestSessionSecret(),
): string {
	return `${guestSessionId}.${sign(guestSessionId, secret)}`
}

export function verifyGuestCookieValue(
	value: string,
	secret = getGuestSessionSecret(),
): string | null {
	const dot = value.lastIndexOf('.')
	if (dot <= 0) return null
	const id = value.slice(0, dot)
	const sig = value.slice(dot + 1)
	if (!/^[0-9a-f-]{8,64}$/i.test(id)) return null
	const expected = sign(id, secret)
	const a = Buffer.from(sig)
	const b = Buffer.from(expected)
	if (a.length !== b.length) return null
	if (!crypto.timingSafeEqual(a, b)) return null
	return id
}

export function generateGuestSessionId(): string {
	return crypto.randomBytes(ID_BYTES).toString('hex')
}

export function buildGuestCookieHeader(signedValue: string, opts: { secure: boolean }): string {
	const parts = [
		`${COOKIE_NAME}=${signedValue}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
	]
	if (opts.secure) parts.push('Secure')
	return parts.join('; ')
}

export function parseGuestCookie(cookieHeader: string | undefined): string | null {
	if (!cookieHeader) return null
	for (const segment of cookieHeader.split(';')) {
		const [name, ...rest] = segment.trim().split('=')
		if (name === COOKIE_NAME) return rest.join('=')
	}
	return null
}
