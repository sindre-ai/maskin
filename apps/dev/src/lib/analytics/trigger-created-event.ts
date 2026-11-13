import { logger } from '../logger'
import type { KnowledgeCreatedVia } from './knowledge-events'
import { capturePosthogEvent } from './posthog'

interface TriggerCreatedProps {
	workspaceId: string
	actorId: string
	/** The caller's actor type from the auth middleware: 'agent' or a person. */
	actorType: string | undefined
	triggerId: string
	/** The trigger's kind: cron, event, slack and so on. Never the name or prompt. */
	triggerType: string
	createdVia: KnowledgeCreatedVia
}

/**
 * One `trigger_created` for every trigger made through the API, whichever surface
 * wrote it (web, an agent, MCP). It used to fire from the browser only, so
 * triggers made by agents or over MCP were never counted. Ids and kinds only,
 * never names or prompts. `actor_type` is set here because the `trigger_` prefix
 * would otherwise mark the event as sent by a trigger. Best-effort: never throws,
 * so callers fire it without awaiting.
 */
export async function trackTriggerCreated(p: TriggerCreatedProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_created', p.actorId, {
			workspace_id: p.workspaceId,
			actor_id: p.actorId,
			actor_type: p.actorType === 'agent' ? 'agent' : 'human',
			entity_id: p.triggerId,
			entity_type: 'trigger',
			trigger_type: p.triggerType,
			created_via: p.createdVia,
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_created', { triggerId: p.triggerId, error: String(err) })
	}
}
