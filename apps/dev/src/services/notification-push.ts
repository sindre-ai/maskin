import type { Database } from '@maskin/db'
import { notifications } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { ApnsSender } from './apns'

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

		await this.sender.sendToActor(n.targetActorId, {
			title: n.title,
			body: n.content,
			workspaceId: n.workspaceId,
			notificationId: n.id,
			objectId: n.objectId,
			conversationId,
		})
	}
}
