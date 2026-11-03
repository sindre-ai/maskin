/**
 * lifecycle-push-scheduler.ts — three one-time pushes for new people.
 *
 *  (a) first_task   The first time an agent session the person started completes successfully:
 *                   "Your agent finished its first task", linked to the session's object.
 *                   Only for people who signed up in the last 14 days, and only when that
 *                   completion happened in the last 24 h and no earlier successful run of
 *                   theirs exists (otherwise the data is ambiguous: skip).
 *  (b) reminder     A decision/question waiting on them (a live For You card, same visibility
 *                   rules as GET /api/for-you) that is 24-72 h old and still pending. ONE
 *                   reminder per card, at most one reminder push per person per rolling 24 h.
 *                   The 72 h ceiling keeps switching the feature on from reminding people
 *                   about old backlog.
 *  (c) activation   3-5 days after sign-up, if they have never started an agent session.
 *                   One nudge, ever.
 *
 * All three are `notifications` rows with `push_category: 'tips'`, `push_force: true`; the push
 * policy still applies quiet hours, the tips toggle and its 2/day limit.
 *
 * Never repeats: what was sent is persisted in `notification_preferences.lifecycle_sent` (jsonb
 * {key: iso}). A claim is a single atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE NOT
 * jsonb_exists(lifecycle_sent, key) RETURNING` in the SAME transaction as the notification
 * insert, so replicas and restarts cannot send twice and a failed insert releases the claim.
 * (A unique key on `notifications` would need a partial unique index on a hot table, which
 * requires CONCURRENTLY and a chunked backfill, and could not express "once per actor" for
 * the reminder's per-day cap.)
 *
 * Off unless PUSH_LIFECYCLE_ENABLED is '1' or 'true'. Only people with a push device are
 * considered, so a claim is never spent on someone who cannot receive it.
 */
import type { Database } from '@maskin/db'
import {
	actors,
	notificationPreferences,
	notifications,
	objects,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import {
	type SQL,
	and,
	asc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	notInArray,
	or,
	sql,
} from 'drizzle-orm'
import { loadVisibleForYou } from '../lib/for-you-visibility'
import { logger } from '../lib/logger'
import { hasPushDevice, insertPushNotification, resolveSourceActor } from './push-schedule-shared'

const TICK_MS = 5 * 60_000
export const ENABLE_ENV_VAR = 'PUSH_LIFECYCLE_ENABLED'
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
export const LIFECYCLE = {
	/** (a) and (c) only apply to people who signed up this recently. */
	newActorMaxAgeMs: 14 * DAY,
	firstTaskFreshMs: DAY,
	reminderMinAgeMs: 24 * HOUR,
	reminderMaxAgeMs: 72 * HOUR,
	reminderEveryMs: DAY,
	activationMinAgeMs: 3 * DAY,
	activationMaxAgeMs: 5 * DAY,
} as const
const LIMIT = 200

export function lifecycleEnabled(env: NodeJS.ProcessEnv): boolean {
	const v = env[ENABLE_ENV_VAR]?.trim().toLowerCase()
	return v === '1' || v === 'true'
}

export type LifecycleKey = 'first_task' | 'activation' | `reminded:${string}`

export class LifecyclePushScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	/** Actors already seen to have started a session: not re-checked on every tick. */
	private hasStartedSession = new Set<string>()

	constructor(
		private db: Database,
		private env: NodeJS.ProcessEnv = process.env,
	) {}

	start(): void {
		if (this.timer) return
		if (!lifecycleEnabled(this.env)) {
			logger.info('LifecyclePushScheduler disabled (PUSH_LIFECYCLE_ENABLED not set)')
			return
		}
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('LifecyclePushScheduler tick failed', { error: String(err) }),
			)
		}, TICK_MS)
		this.timer.unref?.()
		logger.info('LifecyclePushScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for test injection; returns how many pushes were created. */
	async tick(now: Date = new Date()): Promise<number> {
		if (this.running) return 0
		if (!lifecycleEnabled(this.env)) return 0
		this.running = true
		let sent = 0
		try {
			for (const rule of [this.firstTask, this.reminders, this.activation]) {
				try {
					sent += await rule.call(this, now)
				} catch (err) {
					logger.warn('Lifecycle rule failed', { rule: rule.name, error: String(err) })
				}
			}
		} finally {
			this.running = false
		}
		return sent
	}

	/** `actorIdColumn` is NOT among the actors whose `lifecycle_sent` already has `key`. */
	private notSent(actorIdColumn: Parameters<typeof notInArray>[0], key: string): SQL {
		return notInArray(
			actorIdColumn,
			this.db
				.select({ id: notificationPreferences.actorId })
				.from(notificationPreferences)
				.where(sql`jsonb_exists(${notificationPreferences.lifecycleSent}, ${key}::text)`),
		)
	}

	/**
	 * Atomically record `entries` for the actor and, only if this caller won the claim, run
	 * `send` in the same transaction. `guard` adds a condition evaluated against the stored row
	 * under the row lock (used for the reminder's once-a-day cap).
	 */
	private async claimAndSend(
		actorId: string,
		key: string,
		entries: Record<string, string>,
		guard: SQL | null,
		send: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<unknown>,
	): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const payload = JSON.stringify(entries)
			const claimed = await tx.execute(sql`
				INSERT INTO notification_preferences (actor_id, lifecycle_sent)
				VALUES (${actorId}::uuid, ${payload}::jsonb)
				ON CONFLICT (actor_id) DO UPDATE
					SET lifecycle_sent = notification_preferences.lifecycle_sent || ${payload}::jsonb
					WHERE NOT jsonb_exists(notification_preferences.lifecycle_sent, ${key}::text)
					${guard ? sql`AND ${guard}` : sql``}
				RETURNING actor_id`)
			if (claimed.length === 0) return false
			await send(tx)
			return true
		})
	}

	// (a) ────────────────────────────────────────────────────────────────────
	private async firstTask(now: Date): Promise<number> {
		// Range-scans the recent completions (sessions_prune_candidates_idx: completed_at
		// WHERE interactive = false), then joins the few that belong to a recent sign-up.
		const rows = await this.db
			.select({
				sessionId: sessions.id,
				workspaceId: sessions.workspaceId,
				agentId: sessions.actorId,
				ownerId: sessions.createdBy,
				objectId: sessions.initiatedFromObjectId,
				objectTitle: objects.title,
				completedAt: sessions.completedAt,
			})
			.from(sessions)
			.innerJoin(actors, eq(actors.id, sessions.createdBy))
			.leftJoin(objects, eq(objects.id, sessions.initiatedFromObjectId))
			.where(
				and(
					eq(sessions.interactive, false),
					eq(sessions.status, 'completed'),
					gt(sessions.completedAt, new Date(now.getTime() - LIFECYCLE.firstTaskFreshMs)),
					lte(sessions.completedAt, now),
					sql`${sessions.result}->>'error' IS NULL`,
					eq(actors.type, 'human'),
					gt(actors.createdAt, new Date(now.getTime() - LIFECYCLE.newActorMaxAgeMs)),
					hasPushDevice(this.db, sessions.createdBy),
					this.notSent(sessions.createdBy, 'first_task'),
				),
			)
			.orderBy(asc(sessions.completedAt))
			.limit(LIMIT)

		let sent = 0
		const seen = new Set<string>()
		for (const r of rows) {
			if (seen.has(r.ownerId)) continue
			seen.add(r.ownerId)
			const [agent] = await this.db
				.select({ name: actors.name, type: actors.type })
				.from(actors)
				.where(eq(actors.id, r.agentId))
				.limit(1)
			// A person's own session (or an unknown actor) is not "your agent finished".
			if (!agent || agent.type !== 'agent') continue
			// "First" means no other successful, non-chat run of theirs that finished earlier (or
			// at the same moment). Looked up inside the workspaces they belong to, where
			// sessions_ws_status_idx applies. Anything we cannot rule out is skipped.
			const memberOf = await this.db
				.select({ id: workspaceMembers.workspaceId })
				.from(workspaceMembers)
				.where(eq(workspaceMembers.actorId, r.ownerId))
			const [earlier] = await this.db
				.select({ id: sessions.id })
				.from(sessions)
				.where(
					and(
						inArray(
							sessions.workspaceId,
							memberOf.map((m) => m.id),
						),
						eq(sessions.status, 'completed'),
						eq(sessions.createdBy, r.ownerId),
						eq(sessions.interactive, false),
						ne(sessions.id, r.sessionId),
						or(isNull(sessions.completedAt), lte(sessions.completedAt, r.completedAt as Date)),
					),
				)
				.limit(1)
			if (earlier) continue
			const ok = await this.claimAndSend(
				r.ownerId,
				'first_task',
				{ first_task: now.toISOString() },
				null,
				async (tx) =>
					insertPushNotification(tx, {
						workspaceId: r.workspaceId,
						sourceActorId: r.agentId,
						targetActorId: r.ownerId,
						title: 'Your agent finished its first task',
						body: r.objectTitle
							? `${agent.name} finished '${r.objectTitle.slice(0, 80)}'.`
							: `${agent.name} has a result for you.`,
						objectId: r.objectId,
						sessionId: r.sessionId,
						pushCategory: 'tips',
						collapseKey: 'lifecycle:first_task',
						metadata: { kind: 'lifecycle_first_task' },
					}),
			)
			if (ok) sent++
		}
		return sent
	}

	// (b) ────────────────────────────────────────────────────────────────────
	private async reminders(now: Date): Promise<number> {
		const oldest = new Date(now.getTime() - LIFECYCLE.reminderMaxAgeMs)
		const newest = new Date(now.getTime() - LIFECYCLE.reminderMinAgeMs)
		const aged = await this.db
			.select({
				id: notifications.id,
				actorId: notifications.targetActorId,
				workspaceId: notifications.workspaceId,
				createdAt: notifications.createdAt,
			})
			.from(notifications)
			.where(
				and(
					eq(notifications.type, 'needs_input'),
					inArray(notifications.status, ['pending', 'seen']),
					sql`${notifications.metadata}->>'kind' = ${FOR_YOU_KIND}`,
					gt(notifications.createdAt, oldest),
					lte(notifications.createdAt, newest),
					hasPushDevice(this.db, notifications.targetActorId),
				),
			)
			.orderBy(asc(notifications.createdAt))
			.limit(LIMIT)

		const byActor = new Map<string, typeof aged>()
		for (const a of aged) {
			if (!a.actorId) continue
			byActor.set(a.actorId, [...(byActor.get(a.actorId) ?? []), a])
		}
		let sent = 0
		for (const [actorId, items] of byActor) {
			const [prefs] = await this.db
				.select({ sent: notificationPreferences.lifecycleSent })
				.from(notificationPreferences)
				.where(eq(notificationPreferences.actorId, actorId))
				.limit(1)
			const done = prefs?.sent ?? {}
			const last = done.reminder_at ? Date.parse(done.reminder_at) : Number.NaN
			if (Number.isFinite(last) && now.getTime() - last < LIFECYCLE.reminderEveryMs) continue

			const candidateIds = new Set(items.filter((i) => !done[`reminded:${i.id}`]).map((i) => i.id))
			if (candidateIds.size === 0) continue
			let pick: Awaited<ReturnType<typeof loadVisibleForYou>>['cards'][number] | null = null
			for (const workspaceId of new Set(items.map((i) => i.workspaceId))) {
				const visible = await loadVisibleForYou(this.db, workspaceId, actorId)
				for (const card of visible.cards) {
					if (!candidateIds.has(card.row.id)) continue
					const at = card.row.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER
					if (!pick || at < (pick.row.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER)) pick = card
				}
			}
			if (!pick) continue
			const card = pick
			const sourceActorId =
				card.row.sourceActorId !== actorId
					? card.row.sourceActorId
					: await resolveSourceActor(this.db, card.row.workspaceId, actorId)
			if (!sourceActorId) continue
			const stamp = now.toISOString()
			const ok = await this.claimAndSend(
				actorId,
				`reminded:${card.row.id}`,
				{ [`reminded:${card.row.id}`]: stamp, reminder_at: stamp },
				sql`(notification_preferences.lifecycle_sent->>'reminder_at' IS NULL OR (notification_preferences.lifecycle_sent->>'reminder_at')::timestamptz <= ${new Date(now.getTime() - LIFECYCLE.reminderEveryMs).toISOString()}::timestamptz)`,
				async (tx) =>
					insertPushNotification(tx, {
						workspaceId: card.row.workspaceId,
						sourceActorId,
						targetActorId: actorId,
						title: 'Still waiting on you',
						body: card.meta.headline.slice(0, 140),
						objectId: card.row.objectId,
						sessionId: card.row.sessionId,
						pushCategory: 'tips',
						collapseKey: `lifecycle:reminder:${card.row.id}`,
						metadata: { kind: 'lifecycle_reminder', reminder_for: card.row.id },
					}),
			)
			if (ok) sent++
		}
		return sent
	}

	// (c) ────────────────────────────────────────────────────────────────────
	private async activation(now: Date): Promise<number> {
		const rows = await this.db
			.select({ id: actors.id, defaultWorkspaceId: actors.defaultWorkspaceId })
			.from(actors)
			.where(
				and(
					eq(actors.type, 'human'),
					lte(actors.createdAt, new Date(now.getTime() - LIFECYCLE.activationMinAgeMs)),
					gt(actors.createdAt, new Date(now.getTime() - LIFECYCLE.activationMaxAgeMs)),
					hasPushDevice(this.db, actors.id),
					this.notSent(actors.id, 'activation'),
				),
			)
			.orderBy(asc(actors.createdAt))
			.limit(LIMIT)

		let sent = 0
		for (const r of rows) {
			if (this.hasStartedSession.has(r.id)) continue
			const memberships = await this.db
				.select({ workspaceId: workspaceMembers.workspaceId })
				.from(workspaceMembers)
				.where(eq(workspaceMembers.actorId, r.id))
				.orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.workspaceId))
			if (memberships.length === 0) continue
			// Never started ANY session (chat included), the conservative reading. sessions has no
			// created_by index, so look inside their workspaces (sessions_ws_status_idx).
			const [started] = await this.db
				.select({ id: sessions.id })
				.from(sessions)
				.where(
					and(
						inArray(
							sessions.workspaceId,
							memberships.map((m) => m.workspaceId),
						),
						eq(sessions.createdBy, r.id),
					),
				)
				.limit(1)
			if (started) {
				this.hasStartedSession.add(r.id)
				continue
			}
			const workspaceId =
				memberships.find((m) => m.workspaceId === r.defaultWorkspaceId)?.workspaceId ??
				(memberships[0] as { workspaceId: string }).workspaceId
			const sourceActorId = await resolveSourceActor(this.db, workspaceId, r.id)
			if (!sourceActorId) continue
			const ok = await this.claimAndSend(
				r.id,
				'activation',
				{ activation: now.toISOString() },
				null,
				async (tx) =>
					insertPushNotification(tx, {
						workspaceId,
						sourceActorId,
						targetActorId: r.id,
						title: 'Give an agent its first task',
						body: 'Ask an agent to take something off your plate. It will report back here when it is done.',
						pushCategory: 'tips',
						collapseKey: 'lifecycle:activation',
						metadata: { kind: 'lifecycle_activation' },
					}),
			)
			if (ok) sent++
		}
		return sent
	}
}
