/**
 * run-death-alerts.ts — tells the workspace owners when runs die in a way nobody planned for.
 *
 * Two causes reach this today: a run that exited with an error nothing recognised
 * ('unclassified'), and a run whose retries ran out ('retry_cap'). Each becomes ONE For You card
 * per human owner per cause per UTC day, however many runs die the same way. Same shape as the
 * daily budget card: the day is claimed by the audit event the insert already writes, under a
 * per-workspace advisory lock, so two replicas cannot both send it and a deleted card is not
 * sent again.
 *
 * Best-effort by design. A failure here is logged and swallowed: the run is already settled and
 * the alert must never undo that.
 */
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { insertNotificationsWithEvents } from '../lib/notifications'
import { resolveSourceActor } from './push-schedule-shared'

export const RUN_DEATH_SOURCE = 'run_death_alert'
/** Lower sorts first. Above the daily budget report (1000): this is something that broke. */
export const RUN_DEATH_CARD_RANK = 20

export interface RunDeathAlert {
	workspaceId: string
	/** What went wrong, stable across runs: 'unclassified:<fingerprint>' or 'retry_cap:<actor id>'. */
	causeKey: string
	headline: string
	rationale: string
	/** The run that triggered it, so the card can open it. */
	sessionId?: string | null
}

/** UTC calendar day, the unit "once per day" counts in. */
export function alertDay(at: Date): string {
	return at.toISOString().slice(0, 10)
}

/** True when a card was written; false when this cause already reached the owners today or there is no one to tell. */
export async function alertOwnersOncePerDay(
	db: Database,
	alert: RunDeathAlert,
	now: Date = new Date(),
): Promise<boolean> {
	try {
		const owners = await db
			.select({ id: actors.id })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, alert.workspaceId),
					eq(workspaceMembers.role, 'owner'),
					eq(actors.type, 'human'),
				),
			)
			.orderBy(asc(actors.id))
		const targets: Array<{ ownerId: string; sourceActorId: string }> = []
		for (const owner of owners) {
			const sourceActorId = await resolveSourceActor(db, alert.workspaceId, owner.id)
			if (sourceActorId) targets.push({ ownerId: owner.id, sourceActorId })
		}
		if (targets.length === 0) {
			logger.warn('Run death alert skipped: no owner, or no agent to send it from', {
				workspaceId: alert.workspaceId,
				causeKey: alert.causeKey,
			})
			return false
		}

		const day = alertDay(now)
		return await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${`${RUN_DEATH_SOURCE}:${alert.workspaceId}`}))`,
			)
			const taken = await tx.execute(sql`
				SELECT 1 FROM events
				WHERE workspace_id = ${alert.workspaceId}
					AND created_at > now() - interval '2 days'
					AND entity_type = 'notification'
					AND action = 'created'
					AND data->'metadata'->>'source' = ${RUN_DEATH_SOURCE}
					AND data->'metadata'->>'cause_key' = ${alert.causeKey}
					AND data->'metadata'->>'alert_day' = ${day}
				LIMIT 1`)
			if (taken.length > 0) return false

			let created = 0
			for (const { ownerId, sourceActorId } of targets) {
				const rows = await insertNotificationsWithEvents(tx, {
					workspaceId: alert.workspaceId,
					actorId: sourceActorId,
					rows: [
						{
							workspaceId: alert.workspaceId,
							type: 'needs_input',
							title: alert.headline,
							content: alert.rationale,
							sourceActorId,
							targetActorId: ownerId,
							sessionId: alert.sessionId ?? null,
							status: 'pending',
							metadata: {
								kind: FOR_YOU_KIND,
								rank: RUN_DEATH_CARD_RANK,
								headline: alert.headline,
								rationale: alert.rationale,
								source: RUN_DEATH_SOURCE,
								cause_key: alert.causeKey,
								alert_day: day,
							},
						},
					],
				})
				created += rows.length
			}
			return created > 0
		})
	} catch (err) {
		logger.warn('Run death alert failed', {
			workspaceId: alert.workspaceId,
			causeKey: alert.causeKey,
			error: String(err),
		})
		return false
	}
}
