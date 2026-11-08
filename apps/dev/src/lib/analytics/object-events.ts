import { logger } from '../logger'
import type { KnowledgeCreatedVia } from './knowledge-events'
import { capturePosthogEvent } from './posthog'

interface ObjectCreatedProps {
	workspaceId: string
	actorId: string
	objectId: string
	/** The object's `type` column: bet, task, insight, knowledge, loop and so on. */
	objectType: string
	createdVia: KnowledgeCreatedVia
}

/**
 * One `object_created` for every object made through the API, whichever surface
 * wrote it (web, an agent, MCP), with the object type. A loop is also a
 * `loop_created`, so loops can be counted on their own. Ids and types only, never
 * titles or text. Best-effort: never throws, so callers fire it without awaiting.
 */
export async function trackObjectCreated(p: ObjectCreatedProps): Promise<void> {
	const isLoop = p.objectType === 'loop'
	const props = {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		object_id: p.objectId,
		object_type: p.objectType,
		created_via: p.createdVia,
		feature_area: isLoop ? 'loops' : 'objects',
	}
	try {
		await capturePosthogEvent('object_created', p.actorId, props)
		if (isLoop) await capturePosthogEvent('loop_created', p.actorId, props)
	} catch (err) {
		logger.warn('Failed to emit object_created', { objectId: p.objectId, error: String(err) })
	}
}
