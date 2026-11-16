/**
 * heartbeat-precheck.ts — would the daily heartbeat of an owner have anything to do? (bet "Agents
 * take the lead", rule 4, task "Sweep for overdue next steps, wake drivers", item 4.)
 *
 * Asked in code, in the slot cron already has for skip_when_idle, before the heartbeat session
 * starts. RECORD-ONLY: the answer is logged, written as a heartbeat_precheck event on the trigger
 * and sent as driver_woken (source heartbeat), and the run always goes ahead. Switching it on is a
 * separate step that needs the owners' agreement, after the Won, Lost or Inconclusive call on the
 * owner-heartbeat bet. Nothing here can skip a run.
 *
 * A heartbeat has something to do when anything its owner drives is:
 *   - overdue (an open next step past due), or has no next step;
 *   - changed since the last run: somebody else wrote on it, or on anything in a flow it drives, or
 *     a new insight was linked to any of them (new evidence, so a quiet flow is never skipped while
 *     customers are still talking);
 *   - or it is 3 days since the last run (ASSUMED, no source), so numbers kept outside the database
 *     still get read.
 * Only the daily heartbeat triggers are looked at. Scheduled weekly runs are not pre-checked.
 */
import type { Database } from '@maskin/db'
import { events, objects, relationships } from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, ne, notInArray, or } from 'drizzle-orm'
import { HEARTBEAT_METADATA_KEY } from '../services/default-heartbeat'
import type { DriverWakeReason } from './analytics/driver-woken-events'
import { CLOSED_OBJECT_STATUSES } from './for-you-visibility'
import { findObjectsNeedingNextStep } from './next-steps'

/** ASSUMED, no source: a heartbeat that would be skipped still runs once in this long. */
export const HEARTBEAT_FLOOR_MS = 3 * 24 * 60 * 60_000
/** Driven objects read per check. */
const DRIVEN_LIMIT = 500

export type PrecheckReason = Extract<
	DriverWakeReason,
	'step_overdue' | 'no_next_step' | 'new_evidence' | 'floor_reached' | 'nothing_due'
>

export interface PrecheckFacts {
	/** The last time the trigger fired; null if it never has. */
	lastRunAt: Date | null
	now: Date
	overdue: number
	missing: number
	/** Events written by someone other than the owner on what it drives or on its flows' members. */
	otherActorEvents: number
	/** Insights linked to what it drives or to its flows' members since the last run. */
	newInsights: number
}

export interface PrecheckResult {
	/** Why the run is worth starting, or ['nothing_due'] when the pre-check would have skipped it. */
	reasons: PrecheckReason[]
	wouldSkip: boolean
	facts: PrecheckFacts
}

/** Pure: the heartbeat runs for any reason found, and for the floor. Otherwise it would be skipped. */
export function decidePrecheck(facts: PrecheckFacts): PrecheckResult {
	const reasons: PrecheckReason[] = []
	if (facts.overdue > 0) reasons.push('step_overdue')
	if (facts.missing > 0) reasons.push('no_next_step')
	if (facts.otherActorEvents > 0 || facts.newInsights > 0) reasons.push('new_evidence')
	const floorReached =
		!facts.lastRunAt || facts.now.getTime() - facts.lastRunAt.getTime() >= HEARTBEAT_FLOOR_MS
	if (reasons.length === 0 && floorReached) reasons.push('floor_reached')
	return reasons.length === 0
		? { reasons: ['nothing_due'], wouldSkip: true, facts }
		: { reasons, wouldSkip: false, facts }
}

/** Only the daily heartbeat triggers carry this marker; a hand-made or weekly trigger does not. */
export function isDailyHeartbeat(trigger: { metadata: unknown }): boolean {
	const meta = trigger.metadata as Record<string, unknown> | null
	return !!meta && meta[HEARTBEAT_METADATA_KEY] !== undefined
}

export async function readPrecheckFacts(
	db: Database,
	trigger: { id: string; workspaceId: string; targetActorId: string; createdAt: Date | null },
	now: Date,
): Promise<PrecheckFacts> {
	const [lastFired] = await db
		.select({ createdAt: events.createdAt })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, trigger.workspaceId),
				eq(events.entityId, trigger.id),
				eq(events.action, 'trigger_fired'),
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	const lastRunAt = lastFired?.createdAt ?? null

	const due = await findObjectsNeedingNextStep(db, {
		workspaceId: trigger.workspaceId,
		driverId: trigger.targetActorId,
		now,
		limit: DRIVEN_LIMIT,
	})
	const base = {
		lastRunAt,
		now,
		overdue: due.filter((d) => d.reason === 'overdue').length,
		missing: due.filter((d) => d.reason === 'missing').length,
	}
	// No earlier run to compare with: the floor decides, there is nothing "since" to look at.
	if (!lastRunAt) return { ...base, otherActorEvents: 0, newInsights: 0 }

	const driven = await db
		.select({ id: objects.id, type: objects.type })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, trigger.workspaceId),
				eq(objects.driver, trigger.targetActorId),
				notInArray(objects.status, CLOSED_OBJECT_STATUSES),
			),
		)
		.limit(DRIVEN_LIMIT)
	if (driven.length === 0) return { ...base, otherActorEvents: 0, newInsights: 0 }

	// What the owner's flows contain: the members of every loop it drives.
	const loopIds = driven.filter((d) => d.type === 'loop').map((d) => d.id)
	const members = loopIds.length
		? await db
				.select({ id: relationships.targetId })
				.from(relationships)
				.where(
					and(
						inArray(relationships.sourceId, loopIds),
						eq(relationships.type, 'in_loop'),
						eq(relationships.targetType, 'object'),
					),
				)
				.limit(DRIVEN_LIMIT)
		: []
	const watched = [...new Set([...driven.map((d) => d.id), ...members.map((m) => m.id)])]

	const [otherEvent, insightLink] = await Promise.all([
		db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, trigger.workspaceId),
					inArray(events.entityId, watched),
					ne(events.actorId, trigger.targetActorId),
					gt(events.createdAt, lastRunAt),
				),
			)
			.limit(1),
		db
			.select({ id: relationships.id })
			.from(relationships)
			.innerJoin(
				objects,
				or(
					and(eq(objects.id, relationships.sourceId), inArray(relationships.targetId, watched)),
					and(eq(objects.id, relationships.targetId), inArray(relationships.sourceId, watched)),
				),
			)
			.where(
				and(
					eq(objects.type, 'insight'),
					eq(objects.workspaceId, trigger.workspaceId),
					gt(relationships.createdAt, lastRunAt),
				),
			)
			.limit(1),
	])
	return { ...base, otherActorEvents: otherEvent.length, newInsights: insightLink.length }
}
