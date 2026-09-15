import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { googleMeetSpaceIdempotency } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Maskin-side idempotency for `google_meet__create_space`. Meet's
 * `spaces.create` does NOT accept a client-side idempotency key (unlike
 * `calendar.events.insert`, which does — that's the path
 * `create_meet_backed_event` uses, backed by Google-native replay via
 * `conferenceData.createRequest.requestId`).
 *
 * The default key is deterministic on (actor_id, purpose_normalised, YYYY-MM-DD).
 * Same actor + same purpose on the same day → same key → same cached space.
 * Callers that need tighter dedupe (e.g. one space per demo booking) supply
 * their own opaque `idempotency_key`.
 *
 * `purpose_normalised` is trimmed + lowercased + whitespace-collapsed so
 * casual variations ("Sebk demo w/ Acme" vs "sebk  demo w/ acme") don't drift
 * apart and provision two spaces.
 */

export interface IdempotencyReadHit {
	spaceName: string
	meetingCode: string
	meetingUri: string
}

/**
 * Compute the default idempotency key. Callers can override by passing their
 * own key to `create_space`; the default is what keeps a same-day retry from
 * duplicating the space.
 *
 * The date is UTC — a caller crossing midnight-UTC mid-agent-cycle would
 * otherwise get a fresh key on retry and dupe the space. Not perfect (a
 * caller in a very late TZ may want a fresh key at their local midnight, not
 * UTC), but stable + tzdata-free + explicit; callers with a stronger opinion
 * pass their own key.
 */
export function defaultIdempotencyKey(params: { actorId: string; purpose: string; now?: Date }): string {
	const day = (params.now ?? new Date()).toISOString().slice(0, 10)
	const normalised = normalisePurpose(params.purpose)
	return createHash('sha256')
		.update(`${params.actorId}|${normalised}|${day}`)
		.digest('hex')
}

export function normalisePurpose(purpose: string): string {
	return purpose.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Look up a cached space for a (workspace_id, idempotency_key) pair. */
export async function readIdempotency(
	db: Database,
	params: { workspaceId: string; idempotencyKey: string },
): Promise<IdempotencyReadHit | null> {
	const [row] = await db
		.select({
			spaceName: googleMeetSpaceIdempotency.spaceName,
			meetingCode: googleMeetSpaceIdempotency.meetingCode,
			meetingUri: googleMeetSpaceIdempotency.meetingUri,
		})
		.from(googleMeetSpaceIdempotency)
		.where(
			and(
				eq(googleMeetSpaceIdempotency.workspaceId, params.workspaceId),
				eq(googleMeetSpaceIdempotency.idempotencyKey, params.idempotencyKey),
			),
		)
		.limit(1)
	return row ?? null
}

/**
 * Record the (workspace, key) → space mapping. If two calls race, the unique
 * index (workspace_id, idempotency_key) makes the second insert fail on
 * conflict; we surface that by re-reading and returning the winner's row.
 * The caller then treats the winner's space as its own result and does NOT
 * make a second `spaces.create` call.
 *
 * Uses ON CONFLICT DO NOTHING + a follow-up SELECT because Postgres RETURNING
 * only fires on the winner's insert; the loser's INSERT ... RETURNING would
 * come back empty, which the caller can't distinguish from a driver bug
 * without a re-read anyway.
 */
export async function recordIdempotency(
	db: Database,
	params: {
		workspaceId: string
		idempotencyKey: string
		spaceName: string
		meetingCode: string
		meetingUri: string
	},
): Promise<{ inserted: boolean; row: IdempotencyReadHit }> {
	const inserted = await db
		.insert(googleMeetSpaceIdempotency)
		.values({
			workspaceId: params.workspaceId,
			idempotencyKey: params.idempotencyKey,
			spaceName: params.spaceName,
			meetingCode: params.meetingCode,
			meetingUri: params.meetingUri,
		})
		.onConflictDoNothing({
			target: [googleMeetSpaceIdempotency.workspaceId, googleMeetSpaceIdempotency.idempotencyKey],
		})
		.returning({
			spaceName: googleMeetSpaceIdempotency.spaceName,
			meetingCode: googleMeetSpaceIdempotency.meetingCode,
			meetingUri: googleMeetSpaceIdempotency.meetingUri,
		})

	if (inserted.length === 1) {
		return { inserted: true, row: inserted[0] as IdempotencyReadHit }
	}

	// Lost the race — read back the winner. The unique index guarantees
	// exactly one row for this (workspace_id, key) pair.
	const winner = await readIdempotency(db, params)
	if (!winner) {
		// Extremely unlikely: our INSERT didn't produce a row and the SELECT
		// still doesn't find one. Only reachable if the winner was deleted
		// between the ON CONFLICT and the SELECT (which nothing in the write
		// path does today). Bubble up so the caller retries deterministically
		// instead of silently double-provisioning.
		throw new Error(
			'google_meet_space_idempotency: conflict on insert but no row visible on re-read',
		)
	}
	return { inserted: false, row: winner }
}

/**
 * Deterministic default `requestId` for `create_meet_backed_event`. Google's
 * calendar.events.insert treats identical `conferenceData.createRequest.requestId`
 * values as a replay — same request id, same event, same Meet space. Same
 * actor + summary + start → same request id → GCal replay-safe, no Maskin
 * table needed for this path.
 */
export function defaultEventRequestId(params: {
	actorId: string
	summary: string
	startDateTime: string
}): string {
	return createHash('sha256')
		.update(`${params.actorId}|${params.summary}|${params.startDateTime}`)
		.digest('hex')
}
