import type { Database } from '@ai-native/db'
import { events } from '@ai-native/db/schema'
import { logger } from './logger'

interface EventValues {
	workspaceId: string
	actorId: string
	action: string
	entityType: string
	entityId: string
	data?: unknown
}

/**
 * Insert an audit event, logging failures without propagating them.
 * Returns `true` when the event was persisted (and PG NOTIFY will fire),
 * `false` when the insert failed — callers that depend on real-time delivery
 * can check the return value and react accordingly.
 */
export async function logEvent(db: Database, values: EventValues): Promise<boolean> {
	try {
		await db.insert(events).values(values)
		return true
	} catch (err) {
		logger.error('Failed to log event', {
			error: String(err),
			action: values.action,
			entityType: values.entityType,
			entityId: values.entityId,
		})
		return false
	}
}
