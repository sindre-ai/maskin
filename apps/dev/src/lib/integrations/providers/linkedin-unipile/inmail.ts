/**
 * InMail credits, read from Unipile and reduced to what `get_inmail_balance` and
 * `send_inmail` need. Spec: bet aff468ba tech spec §1 (route), §2.6 (balance), §2.7 (floor).
 *
 * The route is `GET /v2/{account_id}/linkedin/inmail-credits?service=classic` and answers
 * `{ credits: { classic, recruiter, sales_navigator } }`. Unipile exposes no refill date and
 * no seat field, so the seat is derived from which keys come back.
 */
import type { CapSpec } from './caps'

/** Classic InMail credits we never spend: sends refuse at or below this many. */
export const INMAIL_CREDIT_FLOOR = 2

/** send_inmail: 5 a day per connected account (spec §4), counted from the action log. */
export const INMAIL_DAILY_CAP: CapSpec = {
	name: 'send_inmail',
	limit: 5,
	tools: ['send_inmail'],
}

/**
 * What marks a chat start as a classic InMail. The reference schema names the field
 * `specifics`; the guide example uses `options`. The body schema rejects neither, so a wrong
 * key silently sends a plain chat start. The deploy check must see credits drop by exactly one;
 * if they do not, switch the key here.
 */
export const INMAIL_CHAT_SPECIFICS = { linkedin: { classic: { inmail: true } } } as const

export type InmailSeat = 'premium' | 'sales_navigator' | 'recruiter' | 'free' | 'unknown'

/** Credit counts as Unipile returned them; `null` when the key was absent. */
export type InmailCredits = {
	classic: number | null
	sales_navigator: number | null
	recruiter: number | null
}

export type InmailBalance = {
	seat: InmailSeat
	credits_classic: number | null
	credits_sales_navigator: number | null
	sendable_now: number
}

export type LinkedInInmailCreditsQuery = {
	account_id: string
}

/** `GET /v2/{account_id}/linkedin/inmail-credits?service=classic`. */
export function inmailCreditsPath(accountId: string): string {
	return `/v2/${encodeURIComponent(accountId)}/linkedin/inmail-credits?service=classic`
}

function creditCount(raw: unknown): number | null {
	return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : null
}

/** True when a send must not go: no classic key at all, or classic credits at or below the floor. */
export function inmailFloorReached(credits: InmailCredits): boolean {
	return credits.classic === null || credits.classic <= INMAIL_CREDIT_FLOOR
}

/** Reads `{ credits: {...} }` off a credits response; anything else is "no keys". */
export function parseInmailCredits(body: unknown): InmailCredits {
	const credits =
		body && typeof body === 'object' ? (body as { credits?: unknown }).credits : undefined
	const rec = credits && typeof credits === 'object' ? (credits as Record<string, unknown>) : {}
	return {
		classic: creditCount(rec.classic),
		sales_navigator: creditCount(rec.sales_navigator),
		recruiter: creditCount(rec.recruiter),
	}
}

/**
 * A classic key means a Premium seat. Only a sales_navigator or recruiter key (no classic)
 * maps to that seat, sales_navigator first. No keys at all means a free account.
 */
export function deriveInmailBalance(credits: InmailCredits): InmailBalance {
	let seat: InmailSeat = 'free'
	if (credits.classic !== null) seat = 'premium'
	else if (credits.sales_navigator !== null) seat = 'sales_navigator'
	else if (credits.recruiter !== null) seat = 'recruiter'
	return {
		seat,
		credits_classic: credits.classic,
		credits_sales_navigator: credits.sales_navigator,
		sendable_now: Math.max(0, (credits.classic ?? 0) - INMAIL_CREDIT_FLOOR),
	}
}

/** What the balance tool reports when the credits call itself failed. */
export const UNKNOWN_INMAIL_BALANCE: InmailBalance = {
	seat: 'unknown',
	credits_classic: null,
	credits_sales_navigator: null,
	sendable_now: 0,
}
