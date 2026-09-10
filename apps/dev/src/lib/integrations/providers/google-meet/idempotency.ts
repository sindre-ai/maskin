import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { googleMeetSpaceIdempotency } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Maskin-side idempotency store for `google_meet__create_space` (bet 947e ·
 * task 824f). Meet v2 `spaces.create` accepts no client-side idempotency key,
 * so a caller that retries after a network blip would otherwise provision a
 * fresh space every time.
 *
 * The store keys on `(workspace_id, idempotency_key)` — the unique index in
 * migration 0070. `space_name` is what a hit returns; a miss records the
 * caller's newly-provisioned space so the next call collides on the key.
 *
 * Default key: `sha256(actor_id + ':' + purpose_normalised + ':' + YYYY-MM-DD)`.
 * A caller can pass `idempotencyKey` explicitly for a tighter/looser window.
 */

/** Normalise the free-text purpose so casing / whitespace variants collide. */
export function normalisePurpose(purpose: string): string {
	return purpose.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Today's date in UTC as `YYYY-MM-DD`, using the caller's supplied `now`. */
export function utcDate(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10)
}

/**
 * Default idempotency key when the caller does not supply one. Two calls
 * within the same UTC day from the same actor with the same purpose collide.
 */
export function defaultSpaceIdempotencyKey(
	actorId: string,
	purpose: string,
	now: Date = new Date(),
): string {
	const source = `${actorId}:${normalisePurpose(purpose)}:${utcDate(now)}`
	return createHash('sha256').update(source).digest('hex')
}

export interface CachedSpace {
	spaceName: string
	createdAt: Date
}

export async function lookupCachedSpace(
	db: Database,
	workspaceId: string,
	idempotencyKey: string,
): Promise<CachedSpace | null> {
	const [row] = await db
		.select({ spaceName: googleMeetSpaceIdempotency.spaceName, createdAt: googleMeetSpaceIdempotency.createdAt })
		.from(googleMeetSpaceIdempotency)
		.where(
			and(
				eq(googleMeetSpaceIdempotency.workspaceId, workspaceId),
				eq(googleMeetSpaceIdempotency.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1)

	if (!row) return null
	return { spaceName: row.spaceName, createdAt: row.createdAt ?? new Date() }
}

export interface RecordSpaceInput {
	db: Database
	workspaceId: string
	idempotencyKey: string
	spaceName: string
	actorId?: string
}

/**
 * Insert the idempotency row on the fresh-provisioning path. Returns the
 * row's `space_name`, which is `input.spaceName` on the winning insert and
 * the cached name from a concurrent racer's insert when this call loses the
 * uniqueness race. Both outcomes are safe — Meet's spaces.create is called
 * only AFTER a lookup miss, so a losing racer merely orphans one duplicate
 * space (the caller returns the cached one, ignoring the fresh one).
 *
 * The `ON CONFLICT DO NOTHING` + follow-up SELECT is the standard pattern for
 * "insert-or-return-existing" without a stored procedure.
 */
export async function recordSpaceIdempotency(input: RecordSpaceInput): Promise<CachedSpace> {
	const { db, workspaceId, idempotencyKey, spaceName, actorId } = input
	await db
		.insert(googleMeetSpaceIdempotency)
		.values({
			workspaceId,
			idempotencyKey,
			spaceName,
			actorId: actorId ?? null,
		})
		.onConflictDoNothing({
			target: [googleMeetSpaceIdempotency.workspaceId, googleMeetSpaceIdempotency.idempotencyKey],
		})

	const cached = await lookupCachedSpace(db, workspaceId, idempotencyKey)
	// A row must exist after the upsert — either our INSERT or the racer's.
	if (!cached) {
		throw new Error(
			`Failed to record google_meet_space_idempotency row for workspace=${workspaceId}`,
		)
	}
	return cached
}

/**
 * Default `conferenceData.createRequest.requestId` for
 * `google_meet__create_meet_backed_event` when the caller does not supply
 * one. Google treats a repeat call with an identical requestId as a replay
 * and returns the existing calendar event + Meet URI — GCal-native
 * idempotency, no Maskin-side ledger required for this tool.
 */
export function defaultCalendarRequestId(
	actorId: string,
	summary: string,
	startDateTime: string,
): string {
	const source = `${actorId}:${summary}:${startDateTime}`
	// Google requires the requestId to be <= 512 chars; sha256 hex is 64.
	return createHash('sha256').update(source).digest('hex')
}
