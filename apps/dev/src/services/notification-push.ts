import type { Database } from '@maskin/db'
import {
	events,
	conversationParticipants,
	messageThreadReads,
	notificationPreferences,
	notifications,
} from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { FOR_YOU_KIND, parseCommentDecision } from '@maskin/shared'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import {
	DEFAULT_PUSH_PREFS,
	LIMITS,
	PushLedger,
	type PushPrefs,
	type PushVerdict,
	type RecentPush,
	collapseKeyOf,
	delaySecondsOf,
	dueAtOf,
	evaluatePush,
	isCriticalCard,
	isForYouCard,
	pushCategoryOf,
	withDeadline,
} from './push-policy'
import type { PushChannel, PushDecision, PushMessage } from './push-types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Fan an in-app notification out as a push on every enabled channel (APNs, Web Push).
 *
 * Hooks the PG NOTIFY `events` stream (post-commit, so a rolled-back
 * notification never pushes) instead of patching each insert site: every
 * notification writer that follows the audit-log rule emits an
 * `entity_type='notification', action='created'` event. Entirely off the write
 * path — a push failure or slowness cannot affect the notification write.
 *
 * Whether a notification pushes at all, and how loudly, is decided by `evaluatePush`
 * (`push-policy.ts`): categories, muted workspaces, quiet hours, rate limits and the For You
 * rollup. A producer can ask for `metadata.push_delay_seconds`: the verdict is then `delay`, an
 * in-process timer fires after that long, and the push is dropped if the notification is no
 * longer pending or the target already read the conversation up to `metadata.message_id`.
 * The timer is NOT persisted: a restart inside the delay window loses that push (acceptable
 * for a nudge, and the in-app notification is unaffected). It can never double-send: the
 * delayed path runs once per notification per process, and a sent notification id is remembered
 * in the ledger; across replicas `apns-collapse-id` / the Web Push topic collapse duplicates.
 */
export class NotificationPushFanout {
	private handler: ((event: PgEvent) => void) | null = null
	private timers = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private channels: PushChannel[],
		private ledger: PushLedger = new PushLedger(),
		private now: () => number = Date.now,
	) {}

	start() {
		this.handler = (event) => {
			if (event.entity_type !== 'notification' || event.action !== 'created') return
			this.handleEvent(event).catch((err) =>
				logger.warn('Notification push fan-out failed', { error: String(err) }),
			)
		}
		this.bridge.on('event', this.handler)
	}

	stop() {
		if (this.handler) this.bridge.off('event', this.handler)
		this.handler = null
		for (const t of this.timers.values()) clearTimeout(t)
		this.timers.clear()
	}

	async handleEvent(event: PgEvent): Promise<void> {
		// Cheap exit before any DB work when no channel is configured.
		const channels = this.channels.filter((c) => c.isEnabled())
		if (channels.length === 0) return

		const [n] = await this.db
			.select()
			.from(notifications)
			.where(eq(notifications.id, event.entity_id))
			.limit(1)
		if (!n) return
		await this.process(n, channels, null)
	}

	/**
	 * Evaluate the policy for one notification row and act on the verdict. `delayedNowMs` is set
	 * on the re-run after a `push_delay_seconds` wait, so a timer firing a hair early cannot
	 * ask for another delay.
	 */
	private async process(
		n: typeof notifications.$inferSelect,
		channels: PushChannel[],
		delayedNowMs: number | null,
	): Promise<void> {
		// No target = broadcast row with no single recipient; self-notifications
		// (the actor acted on their own thing) are not worth a buzz.
		if (!n.targetActorId || n.targetActorId === n.sourceActorId) return
		const targetActorId = n.targetActorId

		const meta = (n.metadata ?? {}) as Record<string, unknown>
		const category = pushCategoryOf({ type: n.type, metadata: meta })
		const createdAt = n.createdAt ?? new Date(this.now())
		const nowMs = delayedNowMs ?? this.now()
		const now = new Date(nowMs)

		const prefs = await this.loadPrefs(targetActorId)
		const recentPushes = await this.recentPushes(n, meta, nowMs)
		// Only a mention needs the decision lookup before the verdict; reuse it for the message.
		const lookedUp = meta.source === 'comment_mention'
		const earlyDecision = lookedUp ? await this.findDecision(n) : null
		const verdict = evaluatePush({
			notification: {
				id: n.id,
				type: n.type,
				workspaceId: n.workspaceId,
				targetActorId,
				createdAt,
				metadata: meta,
				objectId: n.objectId,
			},
			category,
			prefs,
			now,
			recentPushes,
			hasDecision: earlyDecision !== null,
		})

		if (verdict.action === 'skip') {
			logger.debug('Push skipped by policy', { notificationId: n.id, reason: verdict.reason })
			return
		}
		if (verdict.action === 'delay') {
			this.scheduleDelayed(n.id, verdict.delayMs ?? delaySecondsOf(meta) * 1000)
			return
		}

		const conversationId =
			typeof meta.conversation_id === 'string' && UUID_RE.test(meta.conversation_id)
				? meta.conversation_id
				: null

		let message: PushMessage
		if (verdict.action === 'rollup') {
			const badge = await this.pendingCount(targetActorId)
			message = {
				title: `${verdict.rollupCount} things need you`,
				body: null,
				workspaceId: n.workspaceId,
				notificationId: n.id,
				objectId: null,
				conversationId: null,
				decision: null,
				interruption: verdict.interruption,
				badge,
				collapseKey: verdict.collapseKey,
			}
		} else {
			const decision = lookedUp ? earlyDecision : await this.findDecision(n)
			const badge = await this.pendingCount(targetActorId)
			const due = category === 'needs_you' ? dueAtOf(meta) : null
			const body = decision?.ask ?? n.content
			message = {
				title: decision?.title ?? n.title,
				body: due ? withDeadline(body, due, now, prefs.timezone) : body,
				workspaceId: n.workspaceId,
				notificationId: n.id,
				objectId: n.objectId,
				conversationId,
				threadRootId: typeof meta.thread_root_id === 'number' ? meta.thread_root_id : null,
				decision: decision?.push ?? null,
				interruption: verdict.interruption,
				badge,
				collapseKey: verdict.collapseKey,
			}
		}

		this.record(n, meta, category, verdict, nowMs)
		// allSettled: a channel that throws (sendToActor should not) must not starve the others.
		await Promise.allSettled(channels.map((c) => c.sendToActor(targetActorId, message)))
	}

	private record(
		n: typeof notifications.$inferSelect,
		meta: Record<string, unknown>,
		category: RecentPush['category'],
		verdict: PushVerdict,
		nowMs: number,
	) {
		if (!n.targetActorId) return
		this.ledger.record({
			notificationId: n.id,
			actorId: n.targetActorId,
			workspaceId: n.workspaceId,
			category,
			collapseKey: verdict.collapseKey ?? collapseKeyOf(meta),
			at: nowMs,
			sent: true,
			forYou: isForYouCard({ type: n.type, metadata: meta }),
			critical: isCriticalCard(meta),
			rollup: verdict.action === 'rollup',
		})
	}

	private scheduleDelayed(notificationId: string, delayMs: number) {
		if (this.timers.has(notificationId)) return
		const timer = setTimeout(
			() => {
				this.timers.delete(notificationId)
				this.runDelayed(notificationId).catch((err) =>
					logger.warn('Delayed push failed', { notificationId, error: String(err) }),
				)
			},
			Math.max(0, Math.ceil(delayMs)),
		)
		timer.unref?.()
		this.timers.set(notificationId, timer)
	}

	/** After the wait: re-read the row, drop it if resolved or already read, else evaluate again. */
	private async runDelayed(notificationId: string): Promise<void> {
		const channels = this.channels.filter((c) => c.isEnabled())
		if (channels.length === 0) return
		const [n] = await this.db
			.select()
			.from(notifications)
			.where(eq(notifications.id, notificationId))
			.limit(1)
		if (!n || !n.targetActorId) return
		const meta = (n.metadata ?? {}) as Record<string, unknown>
		// Push-only rows (chat replies) are stored 'seen' so they never count toward the pending
		// badge or show in the inbox; they are still waiting to be pushed. Everything else must
		// still be pending.
		const pushOnly = meta.push_only === true && n.status === 'seen'
		if (n.status !== 'pending' && !pushOnly) return
		if (this.ledger.hasSent(n.targetActorId, n.id)) return

		if (await this.alreadyRead(n.targetActorId, meta)) return

		const createdMs = (n.createdAt ?? new Date()).getTime()
		const earliest = createdMs + delaySecondsOf(meta) * 1000
		await this.process(n, channels, Math.max(this.now(), earliest))
	}

	/** True when the actor's read high-water mark already covers `metadata.message_id`. */
	private async alreadyRead(actorId: string, meta: Record<string, unknown>): Promise<boolean> {
		const messageId = meta.message_id
		if (
			typeof meta.conversation_id !== 'string' ||
			!UUID_RE.test(meta.conversation_id) ||
			typeof messageId !== 'number' ||
			!Number.isFinite(messageId)
		) {
			return false
		}
		try {
			if (typeof meta.thread_root_id === 'number') {
				const [thread] = await this.db
					.select({ lastRead: messageThreadReads.lastReadMessageId })
					.from(messageThreadReads)
					.where(
						and(
							eq(messageThreadReads.actorId, actorId),
							eq(messageThreadReads.rootMessageId, meta.thread_root_id),
						),
					)
					.limit(1)
				if (thread != null && Number(thread.lastRead) >= messageId) return true
				// A thread reply is read in the thread, not in the chat: the chat's cursor
				// moving past it says nothing about whether this person opened the thread.
				// A reply that is also in the main chat is read in either place.
				if (meta.thread_also_in_channel !== true) return false
			}
			const [row] = await this.db
				.select({ lastRead: conversationParticipants.lastReadMessageId })
				.from(conversationParticipants)
				.where(
					and(
						eq(conversationParticipants.conversationId, meta.conversation_id),
						eq(conversationParticipants.actorId, actorId),
					),
				)
				.limit(1)
			return row?.lastRead != null && Number(row.lastRead) >= messageId
		} catch (err) {
			// Unknown read state: err on the side of delivering the push.
			logger.warn('Read check for delayed push failed', { actorId, error: String(err) })
			return false
		}
	}

	private async loadPrefs(actorId: string): Promise<PushPrefs> {
		try {
			const [row] = await this.db
				.select()
				.from(notificationPreferences)
				.where(eq(notificationPreferences.actorId, actorId))
				.limit(1)
			if (!row) return DEFAULT_PUSH_PREFS
			return {
				timezone: row.timezone,
				quietHoursStart: row.quietHoursStart,
				quietHoursEnd: row.quietHoursEnd,
				categories: { ...DEFAULT_PUSH_PREFS.categories, ...row.categories },
				mutedWorkspaceIds: row.mutedWorkspaceIds ?? [],
			}
		} catch (err) {
			logger.warn('Notification preferences lookup failed, using defaults', {
				actorId,
				error: String(err),
			})
			return DEFAULT_PUSH_PREFS
		}
	}

	/**
	 * The in-process ledger, plus (for a non-critical For You card only) the actor's recent For
	 * You cards in this workspace read from `notifications`, so the rollup count survives
	 * restarts and sees cards another replica handled.
	 */
	private async recentPushes(
		n: typeof notifications.$inferSelect,
		meta: Record<string, unknown>,
		nowMs: number,
	): Promise<RecentPush[]> {
		const actorId = n.targetActorId as string
		const entries = this.ledger.recent(actorId, nowMs)
		if (!isForYouCard({ type: n.type, metadata: meta }) || isCriticalCard(meta)) return entries
		try {
			const rows = await this.db
				.select({
					id: notifications.id,
					metadata: notifications.metadata,
					createdAt: notifications.createdAt,
				})
				.from(notifications)
				.where(
					and(
						eq(notifications.targetActorId, actorId),
						eq(notifications.workspaceId, n.workspaceId),
						eq(notifications.type, 'needs_input'),
						sql`${notifications.metadata}->>'kind' = ${FOR_YOU_KIND}`,
						gte(notifications.createdAt, new Date(nowMs - LIMITS.rollupWindowMs)),
					),
				)
				.orderBy(desc(notifications.createdAt))
				.limit(25)
			const known = new Set(entries.map((e) => e.notificationId))
			for (const row of rows) {
				if (known.has(row.id)) continue
				const m = (row.metadata ?? {}) as Record<string, unknown>
				entries.push({
					notificationId: row.id,
					actorId,
					workspaceId: n.workspaceId,
					category: 'needs_you',
					collapseKey: null,
					at: (row.createdAt ?? new Date(nowMs)).getTime(),
					sent: false,
					forYou: true,
					critical: isCriticalCard(m),
					rollup: false,
				})
			}
		} catch (err) {
			logger.warn('For You rollup lookup failed', { notificationId: n.id, error: String(err) })
		}
		return entries
	}

	/** The app-icon badge: the actor's pending notifications. Best effort, `null` leaves it alone. */
	private async pendingCount(actorId: string): Promise<number | null> {
		try {
			const [row] = await this.db
				.select({ value: count() })
				.from(notifications)
				.where(and(eq(notifications.targetActorId, actorId), eq(notifications.status, 'pending')))
			const value = Number(row?.value)
			return Number.isSafeInteger(value) && value >= 0 ? value : null
		} catch (err) {
			logger.warn('Badge count for push failed', { actorId, error: String(err) })
			return null
		}
	}

	/**
	 * A `needs_input` notification created by an @mention of the human on an agent's decision
	 * comment carries no pointer to that comment (its metadata only says `source: comment_mention`), so find it: the
	 * newest `commented` event on the same object by the same author whose text is the row's
	 * content, that mentions this target and parses as a decision. Best effort — any failure
	 * just means a plain push, never a lost one.
	 */
	private async findDecision(n: typeof notifications.$inferSelect) {
		if (n.type !== 'needs_input' || !n.objectId || !n.targetActorId) return null
		try {
			const rows = await this.db
				.select({ id: events.id, data: events.data })
				.from(events)
				.where(
					and(
						eq(events.entityType, 'object'),
						eq(events.entityId, n.objectId),
						eq(events.action, 'commented'),
						eq(events.actorId, n.sourceActorId),
					),
				)
				.orderBy(desc(events.id))
				.limit(5)
			for (const row of rows) {
				const data = (row.data ?? {}) as Record<string, unknown>
				if (data.content !== n.content) continue
				if (!Array.isArray(data.mentions) || !data.mentions.includes(n.targetActorId)) continue
				const decision = parseCommentDecision(data.decision)
				if (!decision) continue
				const parent = Number(data.parentEventId)
				const idx = decision.options.findIndex((o) => o.recommended)
				const push: PushDecision = {
					eventId: row.id,
					parentEventId: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
					objectId: n.objectId,
					options: decision.options.map((o) => ({ label: o.label, destructive: o.destructive })),
					recommended: idx >= 0 ? idx : null,
				}
				return { title: decision.title, ask: decision.ask, push }
			}
		} catch (err) {
			logger.warn('Decision lookup for push failed', { notificationId: n.id, error: String(err) })
		}
		return null
	}
}
