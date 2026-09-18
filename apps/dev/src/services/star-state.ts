import type { Database } from '@maskin/db'
import { events, starState } from '@maskin/db/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Per-actor "starred" flag on an entity. Mirrors `read_state` in shape and
 * intent — one row per (actor, entity), presence = starred, absence = not
 * starred (unstar is a row DELETE, no soft-flag). `entity_type = 'object'`
 * is the only surface today; the schema leaves room for future entity types.
 */
export interface StarEntityRef {
	entityType: string
	entityId: string
}

/**
 * Insert (or reuse) a star_state row and append an events audit entry tagged
 * `mutation_type: 'star'`. Idempotent: a second call for the same actor+entity
 * short-circuits on the composite PK, returns the existing `starred_at`, and
 * still emits the event so the SSE bridge flushes cross-device caches even on
 * the no-op path (matches read_state's "always advance the reader" idiom —
 * the caller who tapped star gets an audit row regardless).
 *
 * The `mutation_type: 'star'` tag is load-bearing: the D5 Won criterion is a
 * PostHog cross-device check that reads `object_updated` events with
 * `mutation_type = 'star'` from ≥2 `$device_type` values; without the tag the
 * D5 landing verdict lands Inconclusive.
 *
 * NOTIFY on the events row is emitted automatically by the `events_notify`
 * Postgres trigger (see packages/db/drizzle/0006_notify_drop_data.sql).
 */
export async function starObject(
	db: Database,
	args: {
		workspaceId: string
		actorId: string
		objectId: string
		objectType: string
	},
): Promise<{ isStarredByMe: true; starredAt: Date }> {
	// ON CONFLICT DO UPDATE with a no-op set so RETURNING always yields the
	// canonical row (its original starred_at on a repeat call, not a fresh
	// timestamp). Plain DO NOTHING skips RETURNING for the losing row.
	const [row] = await db
		.insert(starState)
		.values({
			workspaceId: args.workspaceId,
			actorId: args.actorId,
			entityType: 'object',
			entityId: args.objectId,
		})
		.onConflictDoUpdate({
			target: [starState.actorId, starState.entityType, starState.entityId],
			set: { actorId: sql`${starState.actorId}` },
		})
		.returning({ starredAt: starState.starredAt })

	await db.insert(events).values({
		workspaceId: args.workspaceId,
		actorId: args.actorId,
		action: 'starred',
		entityType: args.objectType,
		entityId: args.objectId,
		data: { mutation_type: 'star', is_starred: true },
	})

	return { isStarredByMe: true, starredAt: row?.starredAt ?? new Date() }
}

/**
 * Delete the actor's star_state row for this entity and append an events
 * audit entry tagged `mutation_type: 'star'`. Idempotent — a call for an
 * absent row still writes the event (same reasoning as `starObject`: the
 * per-caller mutation is what we're recording, not the DB row transition).
 */
export async function unstarObject(
	db: Database,
	args: {
		workspaceId: string
		actorId: string
		objectId: string
		objectType: string
	},
): Promise<{ isStarredByMe: false }> {
	await db
		.delete(starState)
		.where(
			and(
				eq(starState.actorId, args.actorId),
				eq(starState.entityType, 'object'),
				eq(starState.entityId, args.objectId),
			),
		)

	await db.insert(events).values({
		workspaceId: args.workspaceId,
		actorId: args.actorId,
		action: 'unstarred',
		entityType: args.objectType,
		entityId: args.objectId,
		data: { mutation_type: 'star', is_starred: false },
	})

	return { isStarredByMe: false }
}

/**
 * Whether the actor has starred a single entity. Used by detail-endpoint
 * hydration. Returns false when no row exists — never null, never throws on
 * a non-existent entity.
 */
export async function isObjectStarredByActor(
	db: Database,
	args: { actorId: string; objectId: string },
): Promise<boolean> {
	const [row] = await db
		.select({ entityId: starState.entityId })
		.from(starState)
		.where(
			and(
				eq(starState.actorId, args.actorId),
				eq(starState.entityType, 'object'),
				eq(starState.entityId, args.objectId),
			),
		)
		.limit(1)
	return Boolean(row)
}

/**
 * Batch-hydrate the "starred by this actor" set for a page of object ids —
 * one round-trip regardless of page size. Called once per list handler
 * keyed on the ids the page returned, then merged into each row as
 * `is_starred_by_me` per the D5 tech-spec pattern (mirrors read_state's
 * secondary-query approach; NOT a per-row LEFT JOIN inside the main list
 * query, which would tie the star cache to the base list SQL and defeat
 * the point of the polymorphic table).
 *
 * Returns an empty set on an empty input rather than issuing a no-arg
 * `= ANY({}::uuid[])` query.
 */
export async function getStarredObjectIds(
	db: Database,
	args: { actorId: string; objectIds: string[] },
): Promise<Set<string>> {
	if (args.objectIds.length === 0) return new Set()
	const rows = await db
		.select({ entityId: starState.entityId })
		.from(starState)
		.where(
			and(
				eq(starState.actorId, args.actorId),
				eq(starState.entityType, 'object'),
				inArray(starState.entityId, args.objectIds),
			),
		)
	return new Set(rows.map((r) => r.entityId))
}
