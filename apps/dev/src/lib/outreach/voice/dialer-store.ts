import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { and, count, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import { applyVoiceEvent, runAppliedEffects } from './apply'
import { RETRY_STATUSES } from './dialer'
import type { DialerStore, QueuedContact } from './dialer'
import { type EffectRunner, createDefaultEffectRunner } from './effects'

const nextDialAt = sql`(${objects.metadata}->>'next_dial_at')::timestamptz`

/**
 * The due-queue predicate, one workspace or (null) every workspace. Served by
 * objects_ws_type_status_idx: an IN list on status, no new index.
 */
function dueQueue(workspaceId: string | null, now: Date) {
	const nowIso = now.toISOString()
	return and(
		workspaceId === null ? undefined : eq(objects.workspaceId, workspaceId),
		eq(objects.type, 'contact'),
		or(
			and(
				eq(objects.status, 'voice_queued'),
				or(sql`${nextDialAt} is null`, sql`${nextDialAt} <= ${nowIso}::timestamptz`),
			),
			and(
				inArray(objects.status, [...RETRY_STATUSES]),
				sql`${nextDialAt} is not null`,
				sql`${nextDialAt} <= ${nowIso}::timestamptz`,
			),
		),
	)
}

/** Workspaces with at least one due contact. An idle workspace gets no tick and no tick event. */
export async function findWorkspacesWithDueContacts(db: Database, now: Date): Promise<string[]> {
	const rows = await db
		.selectDistinct({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(dueQueue(null, now))
	return rows.map((r) => r.workspaceId)
}

export function createDrizzleDialerStore(
	db: Database,
	runner: EffectRunner = createDefaultEffectRunner(db),
): DialerStore {
	return {
		async readQueue(workspaceId, now, limit) {
			const rows = await db
				.select({
					id: objects.id,
					status: objects.status,
					metadata: objects.metadata,
					nextDialAt: sql<string | null>`${objects.metadata}->>'next_dial_at'`,
				})
				.from(objects)
				.where(dueQueue(workspaceId, now))
				.orderBy(sql`coalesce(${nextDialAt}, ${objects.createdAt}) asc`)
				.limit(limit)
			return rows.map(
				(r): QueuedContact => ({
					id: r.id,
					status: r.status,
					metadata: (r.metadata ?? null) as Record<string, unknown> | null,
					nextDialAt: r.nextDialAt,
				}),
			)
		},

		async claim(workspaceId, contact, actorId, now) {
			return db.transaction(async (tx) => {
				const claimed = await tx
					.update(objects)
					.set({ status: 'voice_dialing', updatedAt: now })
					.where(
						and(
							eq(objects.id, contact.id),
							eq(objects.workspaceId, workspaceId),
							eq(objects.type, 'contact'),
							eq(objects.status, contact.status),
							sql`(${objects.metadata}->>'next_dial_at') is not distinct from ${contact.nextDialAt}::text`,
						),
					)
					.returning({ id: objects.id })
				if (claimed.length === 0) return false
				await recordEvent(tx, {
					workspaceId,
					actorId,
					action: 'status_changed',
					entityType: 'object',
					entityId: contact.id,
					data: {
						source: 'voice_dialer_claim',
						fromStatus: contact.status,
						toStatus: 'voice_dialing',
					},
				})
				return true
			})
		},

		async countCallInitiated(workspaceId, since) {
			const [row] = await db
				.select({ n: count() })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.action, 'call_initiated'),
						gte(events.createdAt, since),
					),
				)
			return row?.n ?? 0
		},

		async recordEvent(event) {
			await recordEvent(db, event)
		},

		async stampMetadata(workspaceId, contactId, patch) {
			// One statement, so it cannot interleave with the reducer's own metadata write.
			await db
				.update(objects)
				.set({
					metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
				})
				.where(
					and(
						eq(objects.id, contactId),
						eq(objects.workspaceId, workspaceId),
						eq(objects.type, 'contact'),
					),
				)
		},

		async failContact(workspaceId, contactId, reason) {
			const applied = await applyVoiceEvent(db, {
				workspaceId,
				contactId,
				event: { type: 'rest_failure', reason },
			})
			if (applied.found && applied.applied) await runAppliedEffects(applied, runner)
		},
	}
}
