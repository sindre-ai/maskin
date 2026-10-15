import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm'
import { recordEvent } from '../../events/record-event'
import type { DialingContact, StaleClaimStore } from './stale-claim-sweep'
import { SWEEP_END_REASON, SWEEP_EVENT_SOURCE, SWEEP_REASON } from './stale-claim-sweep'

const source = sql<string | null>`${events.data}->>'source'`
const voiceEvent = sql<string | null>`${events.data}->>'voice_event'`

/** The reducer's audit row for a call.initiated webhook (apply.ts). Not the dialer's own call_initiated event. */
const webhookCallInitiated = and(
	sql`${events.data}->>'source' = 'telnyx_webhook'`,
	sql`${events.data}->>'voice_event' = 'call_initiated'`,
)

/** The dialer's claim audit row (dialer-store.ts claim). */
const claimEvent = and(
	eq(events.action, 'status_changed'),
	sql`${events.data}->>'source' = 'voice_dialer_claim'`,
)

export function createDrizzleStaleClaimStore(db: Database): StaleClaimStore {
	return {
		async readDialing() {
			// objects_ws_type_status_idx: type and status, no new index.
			const rows = await db
				.select({
					id: objects.id,
					workspaceId: objects.workspaceId,
					updatedAt: objects.updatedAt,
					dialAttemptN: sql<string | null>`${objects.metadata}->>'dial_attempt_n'`,
				})
				.from(objects)
				.where(and(eq(objects.type, 'contact'), eq(objects.status, 'voice_dialing')))

			const idsByWorkspace = new Map<string, string[]>()
			for (const r of rows) {
				const ids = idsByWorkspace.get(r.workspaceId) ?? []
				ids.push(r.id)
				idsByWorkspace.set(r.workspaceId, ids)
			}

			// events_ws_entity_id_idx (workspace, entity, id): one read per workspace for the
			// claim and webhook rows of just those contacts.
			const claimByContact = new Map<string, { id: number; createdAt: Date }>()
			const webhooksByContact = new Map<string, { id: number; createdAt: Date }[]>()
			for (const [workspaceId, ids] of idsByWorkspace) {
				const evs = await db
					.select({
						id: events.id,
						entityId: events.entityId,
						createdAt: events.createdAt,
						source,
						voiceEvent,
					})
					.from(events)
					.where(
						and(
							eq(events.workspaceId, workspaceId),
							inArray(events.entityId, ids),
							or(claimEvent, webhookCallInitiated),
						),
					)
				for (const e of evs) {
					const at = { id: e.id, createdAt: e.createdAt ?? new Date(0) }
					if (e.source === 'voice_dialer_claim') {
						const best = claimByContact.get(e.entityId)
						if (!best || at.id > best.id) claimByContact.set(e.entityId, at)
					} else {
						const list = webhooksByContact.get(e.entityId) ?? []
						list.push(at)
						webhooksByContact.set(e.entityId, list)
					}
				}
			}

			return rows.map((r): DialingContact => {
				const claim = claimByContact.get(r.id)
				const webhooks = webhooksByContact.get(r.id) ?? []
				// Without a claim event the object's updated_at stands in for the claim time. A row with
				// neither reads as claimed just now, so it is skipped rather than swept.
				const claimedAt = claim?.createdAt ?? r.updatedAt ?? new Date()
				const n = Number(r.dialAttemptN)
				return {
					workspaceId: r.workspaceId,
					contactId: r.id,
					claimedAt,
					claimSource: claim ? 'claim_event' : 'updated_at',
					claimEventId: claim?.id ?? null,
					webhookAfterClaim: webhooks.some((w) =>
						claim ? w.id > claim.id : w.createdAt.getTime() > claimedAt.getTime(),
					),
					dialAttemptN: Number.isFinite(n) ? n : 0,
				}
			})
		},

		async sweep(contact, actorId, now, thresholdMinutes) {
			return db.transaction(async (tx) => {
				// The row lock serialises with the reducer (apply.ts locks the same row): either
				// its call.initiated commits first and the recheck below sees it, or this commits
				// first and the late webhook revives the contact, which is the true state.
				const [row] = await tx
					.select({ id: objects.id })
					.from(objects)
					.where(
						and(
							eq(objects.id, contact.contactId),
							eq(objects.workspaceId, contact.workspaceId),
							eq(objects.type, 'contact'),
							eq(objects.status, 'voice_dialing'),
						),
					)
					.for('update')
					.limit(1)
				if (!row) return false

				const [arrived] = await tx
					.select({ id: events.id })
					.from(events)
					.where(
						and(
							eq(events.workspaceId, contact.workspaceId),
							eq(events.entityId, contact.contactId),
							webhookCallInitiated,
							contact.claimEventId !== null
								? gt(events.id, contact.claimEventId)
								: gt(events.createdAt, contact.claimedAt),
						),
					)
					.limit(1)
				if (arrived) return false

				// Writes the status directly, outside advance(): the reducer's rest_failure is not
				// status-conditional and would overwrite a call that has since been answered.
				const swept = await tx
					.update(objects)
					.set({
						status: 'voice_failed',
						updatedAt: now,
						metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || ${JSON.stringify({ voice_end_reason: SWEEP_END_REASON })}::jsonb`,
					})
					.where(
						and(
							eq(objects.id, contact.contactId),
							eq(objects.workspaceId, contact.workspaceId),
							eq(objects.type, 'contact'),
							eq(objects.status, 'voice_dialing'),
						),
					)
					.returning({ id: objects.id })
				if (swept.length === 0) return false

				await recordEvent(tx, {
					workspaceId: contact.workspaceId,
					actorId,
					action: 'status_changed',
					entityType: 'object',
					entityId: contact.contactId,
					// Never data.voice_event: the next run would read this row as webhook arrival.
					data: {
						source: SWEEP_EVENT_SOURCE,
						fromStatus: 'voice_dialing',
						toStatus: 'voice_failed',
						voice_end_reason: SWEEP_END_REASON,
						reason: SWEEP_REASON,
						claimed_at: contact.claimedAt.toISOString(),
						claim_time_source: contact.claimSource,
						threshold_minutes: thresholdMinutes,
					},
				})
				return true
			})
		},

		async recordEvent(event) {
			await recordEvent(db, event)
		},
	}
}
