import { AUTH_TAG_LENGTH, IV_LENGTH, open, seal } from '../../crypto'

/**
 * Launch ticket for a native (ASWebAuthenticationSession) connect.
 *
 * The generic connect route binds the OAuth `state` to the requesting browser
 * with a cookie set on the `POST /:provider/connect` response. A native app
 * makes that POST from URLSession, whose cookie jar is not the web-auth
 * session's, so the cookie would never reach the browser that finishes the flow
 * and the callback would reject it as "not started in this browser".
 *
 * Instead the native connect response hands back a URL on our own origin
 * (`GET /:provider/native-launch?ticket=...`). Opening it in the web-auth
 * session sets the binding cookie in THAT browser and 302s to the provider. The
 * ticket seals the provider authorize URL (built server-side, never taken from
 * the client) together with the nonce, so the launch endpoint redirects only to
 * a URL this server minted for this nonce. It is single-use (the launch route
 * claims the pending row atomically) and short-lived: it is a bearer
 * link, and the shorter it lives the smaller the window in which it could be
 * handed to a different browser.
 */
export const NATIVE_LAUNCH_TTL_MS = 2 * 60 * 1000

export interface NativeLaunchTicket {
	/** Marker so a launch ticket can never be mistaken for an OAuth `state`. */
	kind: 'native-launch'
	provider: string
	nonce: string
	installUrl: string
	ts: number
	/** Workspace of the flow; only used to build the error redirect on a re-open. */
	workspaceId?: string
	/** Allowlisted app return target, re-checked before it reaches a 302. */
	nativeReturn?: string
}

export function encodeLaunchTicket(ticket: NativeLaunchTicket): string {
	const { iv, authTag, encrypted } = seal(JSON.stringify(ticket))
	return Buffer.concat([iv, authTag, encrypted]).toString('base64url')
}

/** The ticket if it authenticates and is fresh, otherwise `null`. Never throws. */
export function decodeLaunchTicket(raw: string, now = Date.now()): NativeLaunchTicket | null {
	try {
		const buf = Buffer.from(raw, 'base64url')
		if (buf.length <= IV_LENGTH + AUTH_TAG_LENGTH) return null
		const parsed = JSON.parse(
			open(
				buf.subarray(0, IV_LENGTH),
				buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH),
				buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH),
			),
		) as Partial<NativeLaunchTicket>
		if (
			parsed.kind !== 'native-launch' ||
			typeof parsed.provider !== 'string' ||
			typeof parsed.nonce !== 'string' ||
			typeof parsed.installUrl !== 'string' ||
			typeof parsed.ts !== 'number'
		) {
			return null
		}
		if (now - parsed.ts > NATIVE_LAUNCH_TTL_MS || parsed.ts > now + 5_000) return null
		return {
			...(parsed as NativeLaunchTicket),
			workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined,
			nativeReturn: typeof parsed.nativeReturn === 'string' ? parsed.nativeReturn : undefined,
		}
	} catch {
		return null
	}
}
