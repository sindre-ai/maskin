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

/** Insert an audit event, logging failures without propagating them. */
export async function logEvent(db: Database, values: EventValues): Promise<void> {
	try {
		await db.insert(events).values(values)
	} catch (err) {
		logger.error('Failed to log event', {
			error: String(err),
			action: values.action,
			entityType: values.entityType,
			entityId: values.entityId,
		})
	}
}
