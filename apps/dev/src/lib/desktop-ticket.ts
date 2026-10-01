import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Short-lived, single-use tickets that authorise ONE desktop WebSocket upgrade.
//
// Browsers cannot send an Authorization header on a WebSocket, and the API key
// must never go in a URL. So the authenticated POST /api/desktop/connect mints
// a ticket, and the browser presents it once on the upgrade. Stateless (HMAC)
// so no table is needed; single-use is enforced best-effort in memory, which is
// enough because the TTL is also short.

export const DESKTOP_TICKET_TTL_MS = 30_000

type TicketPayload = { w: string; a: string; e: number; n: string }

export type DesktopTicketClaims = { workspaceId: string; actorId: string }

// Domain-separated from every other use of INTEGRATION_ENCRYPTION_KEY, so a
// ticket can never be confused with (or forged from) an encrypted credential.
function signingKey(): Buffer {
	const raw = process.env.INTEGRATION_ENCRYPTION_KEY
	if (!raw) throw new Error('INTEGRATION_ENCRYPTION_KEY environment variable is required')
	return createHmac('sha256', Buffer.from(raw, 'hex')).update('maskin:desktop-ticket:v1').digest()
}

function sign(body: string): string {
	return createHmac('sha256', signingKey()).update(body).digest('base64url')
}

// nonce -> expiry, for single-use. Pruned on every call.
const usedNonces = new Map<string, number>()

function pruneUsed(now: number): void {
	for (const [nonce, exp] of usedNonces) {
		if (exp <= now) usedNonces.delete(nonce)
	}
}

export function signDesktopTicket(claims: DesktopTicketClaims, now = Date.now()): string {
	const payload: TicketPayload = {
		w: claims.workspaceId.toLowerCase(),
		a: claims.actorId.toLowerCase(),
		e: now + DESKTOP_TICKET_TTL_MS,
		n: randomBytes(12).toString('base64url'),
	}
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `${body}.${sign(body)}`
}

/** Returns the claims and consumes the ticket, or null if invalid/expired/reused. */
export function consumeDesktopTicket(ticket: string, now = Date.now()): DesktopTicketClaims | null {
	const dot = ticket.indexOf('.')
	if (dot <= 0 || dot === ticket.length - 1) return null
	const body = ticket.slice(0, dot)
	const given = Buffer.from(ticket.slice(dot + 1))
	const expected = Buffer.from(sign(body))
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

	let payload: TicketPayload
	try {
		payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload
	} catch {
		return null
	}
	if (
		typeof payload.w !== 'string' ||
		typeof payload.a !== 'string' ||
		typeof payload.e !== 'number' ||
		typeof payload.n !== 'string'
	) {
		return null
	}
	pruneUsed(now)
	if (payload.e <= now) return null
	if (usedNonces.has(payload.n)) return null
	usedNonces.set(payload.n, payload.e)
	return { workspaceId: payload.w, actorId: payload.a }
}
