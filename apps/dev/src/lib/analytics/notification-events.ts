import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

interface CreateNotificationCalledProps {
	db: Database
	workspaceId: string
	actorId: string
	actorType: string
	notificationId: string
	notificationType: string
}

/**
 * Fires `create_notification_called` when an agent invokes the deprecated
 * notification-creation path. Human-driven POSTs (UI actions, admin tools)
 * are ignored so the ship-metric count reflects agents only.
 *
 * The event is best-effort: any lookup or PostHog failure is swallowed so
 * the caller (route handler) is never blocked by analytics.
 */
export async function trackCreateNotificationCalled(
	p: CreateNotificationCalledProps,
): Promise<void> {
	if (p.actorType !== 'agent') return
	try {
		const [row] = await p.db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, p.actorId))
			.limit(1)
		const agentName = row?.name ?? 'unknown'
		await capturePosthogEvent('create_notification_called', p.actorId, {
			workspace_id: p.workspaceId,
			agent_id: p.actorId,
			agent_name: agentName,
			notification_id: p.notificationId,
			notification_type: p.notificationType,
		})
	} catch (err) {
		logger.warn('Failed to emit create_notification_called', {
			notificationId: p.notificationId,
			error: String(err),
		})
	}
}

interface NotificationSentProps {
	workspaceId: string
	/** The person the push is for. */
	actorId: string
	notificationId: string
	notificationType: string
	category: string
	/** True when the push is the "N things need you" rollup, not the notification's own text. */
	rollup: boolean
}

/**
 * Fires `notification_sent` once for each notification the push fan-out sends to a person's
 * devices (tracking plan row 8). The opens come back as `notification_opened` from the web
 * and `push_notification_opened` from the iPhone app, with the same `notification_id` and
 * `type`. Ids and categories only: never the title or the text. Best-effort, never throws.
 */
export async function trackNotificationSent(p: NotificationSentProps): Promise<void> {
	try {
		await capturePosthogEvent('notification_sent', p.actorId, {
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
			notification_id: p.notificationId,
			type: p.notificationType,
			category: p.category,
			rollup: p.rollup,
		})
	} catch (err) {
		logger.warn('Failed to emit notification_sent', {
			notificationId: p.notificationId,
			error: String(err),
		})
	}
}
