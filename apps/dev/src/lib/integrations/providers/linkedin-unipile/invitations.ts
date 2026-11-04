/**
 * Sent LinkedIn invitations, read from Unipile and reduced to what
 * `list_sent_invitations` reports. Spec: bet aff468ba tech spec §1 (routes), §2.1 (list).
 *
 * Both routes hang off `users/me/relation-requests`, the same collection
 * `sendConnectionRequest` posts to. LinkedIn pages the list with `offset`, not a cursor.
 * Cancelling a request id also refuses a RECEIVED invite with the same call, which is why
 * the withdraw tool must confirm an id is in this sent list before it cancels anything.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export type LinkedInListRelationRequestsQuery = {
	account_id: string
	offset?: number
	limit?: number
}

export type LinkedInCancelRelationRequestPayload = {
	account_id: string
	request_id: string
}

/** `GET /v2/{account_id}/users/me/relation-requests?type=sent&offset=&limit=`. */
export function listRelationRequestsPath(query: LinkedInListRelationRequestsQuery): string {
	const params = new URLSearchParams({ type: 'sent' })
	if (typeof query.offset === 'number') params.set('offset', String(query.offset))
	if (typeof query.limit === 'number') params.set('limit', String(query.limit))
	return `/v2/${encodeURIComponent(query.account_id)}/users/me/relation-requests?${params.toString()}`
}

/** `POST /v2/{account_id}/users/me/relation-requests/{request_id}/cancel`. */
export function cancelRelationRequestPath(payload: LinkedInCancelRelationRequestPayload): string {
	return `/v2/${encodeURIComponent(payload.account_id)}/users/me/relation-requests/${encodeURIComponent(payload.request_id)}/cancel`
}

/** One sent invitation as `list_sent_invitations` reports it. */
export type SentInvitation = {
	invitation_id: string
	recipient_provider_id: string | null
	public_identifier: string | null
	name: string | null
	headline: string | null
	/** ISO time Unipile gave for the invite, or null when it gave none. */
	sent_at: string | null
	/** Whole days since `sent_at`, or null when `sent_at` is null. */
	age_days: number | null
	message: string | null
}

export type SentInvitationsPage = {
	invitations: SentInvitation[]
	/** Rows LinkedIn returned on this page, before any filtering. */
	row_count: number
	/** `total_count` from the envelope; null when Unipile did not send one. */
	total: number | null
}

function str(raw: unknown): string | null {
	return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** Normalises a timestamp to ISO; anything that is not a real date is "no date". */
function isoOrNull(raw: unknown): string | null {
	if (typeof raw !== 'string' || raw.length === 0) return null
	const t = Date.parse(raw)
	return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/**
 * Whole days between `sentAt` and `now`, rounded down. A date in the future (clock skew)
 * counts as 0 rather than going negative. Null in, null out.
 */
export function inviteAgeDays(sentAt: string | null, now: Date): number | null {
	if (sentAt === null) return null
	return Math.max(0, Math.floor((now.getTime() - Date.parse(sentAt)) / DAY_MS))
}

/**
 * Reads a relation-requests response. The person sits under `user`; a flat row is
 * tolerated. Rows without an id are dropped (nothing could act on them) but still count
 * toward `row_count`, because the offset moves by what LinkedIn returned, not by what we kept.
 */
export function parseSentInvitations(body: unknown, now: Date): SentInvitationsPage {
	const env = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
	const rows = Array.isArray(env.data) ? env.data : Array.isArray(env.items) ? env.items : []
	const invitations: SentInvitation[] = []
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue
		const r = row as Record<string, unknown>
		const id = str(r.id)
		if (!id) continue
		const user: Record<string, unknown> =
			r.user && typeof r.user === 'object' ? (r.user as Record<string, unknown>) : {}
		const sentAt = isoOrNull(r.created_at)
		invitations.push({
			invitation_id: id,
			recipient_provider_id: str(user.id),
			public_identifier: str(user.public_identifier),
			name: str(user.display_name),
			headline: str(user.description),
			sent_at: sentAt,
			age_days: inviteAgeDays(sentAt, now),
			message: str(r.message),
		})
	}
	const total =
		typeof env.total_count === 'number' && Number.isFinite(env.total_count) && env.total_count >= 0
			? Math.floor(env.total_count)
			: null
	return { invitations, row_count: rows.length, total }
}

/**
 * Where the next page starts, or null when this was the last one. With a known total the
 * answer is exact. Without one, a full page means there may be more and a short page means
 * there is not. The offset counts rows on LinkedIn's list, never rows kept by a filter.
 */
export function nextSentOffset(
	offset: number,
	limit: number,
	page: Pick<SentInvitationsPage, 'row_count' | 'total'>,
): number | null {
	if (page.row_count === 0) return null
	const next = offset + page.row_count
	if (page.total !== null) return next < page.total ? next : null
	return page.row_count >= limit ? next : null
}
