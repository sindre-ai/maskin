import type { Database } from '@maskin/db'
import { events, notifications } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { parseCommentDecision } from '@maskin/shared'
import { and, count, desc, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { ApnsSender, PushDecision } from './apns'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Fan an in-app notification out as an APNs push.
 *
 * Hooks the PG NOTIFY `events` stream (post-commit, so a rolled-back
 * notification never pushes) instead of patching each insert site: every
 * notification writer that follows the audit-log rule emits an
 * `entity_type='notification', action='created'` event. Entirely off the write
 * path — a push failure or slowness cannot affect the notification write.
 */
export class NotificationPushFanout {
	private handler: ((event: PgEvent) => void) | null = null

	constructor(
		private db: Database,
		private bridge: PgNotifyBridge,
		private sender: ApnsSender,
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
	}

	async handleEvent(event: PgEvent): Promise<void> {
		// Cheap exit before any DB work when push isn't configured.
		if (!this.sender.isEnabled()) return

		const [n] = await this.db
			.select()
			.from(notifications)
			.where(eq(notifications.id, event.entity_id))
			.limit(1)
		// No target = broadcast row with no single recipient; self-notifications
		// (the actor acted on their own thing) are not worth a buzz.
		if (!n?.targetActorId || n.targetActorId === n.sourceActorId) return

		const meta = (n.metadata ?? {}) as Record<string, unknown>
		const conversationId =
			typeof meta.conversation_id === 'string' && UUID_RE.test(meta.conversation_id)
				? meta.conversation_id
				: null

		const decision = await this.findDecision(n)

		const badge = await this.pendingCount(n.targetActorId)

		await this.sender.sendToActor(n.targetActorId, {
			title: decision?.title ?? n.title,
			body: decision?.ask ?? n.content,
			workspaceId: n.workspaceId,
			notificationId: n.id,
			objectId: n.objectId,
			conversationId,
			decision: decision?.push ?? null,
			// A decision, or anything else waiting on this person, should break through Focus.
			interruption: decision || n.type === 'needs_input' ? 'time-sensitive' : 'active',
			badge,
		})
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
	 * comment carries no pointer to that comment (the row's metadata is empty), so find it: the
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
					options: decision.options.map((o) => ({ label: o.label })),
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
