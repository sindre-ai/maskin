import type { Database } from '@maskin/db'
import { events } from '@maskin/db/schema'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Canonical spelling of the Knowledge close loop bet's ship-metric action.
// The `events.action` column is unconstrained text (packages/db/src/schema.ts
// line 146), so the pipeline accepts any string — this constant exists so
// downstream readers (SSE consumers, the T6 "Referenced by N sessions/week"
// chip, and the PostHog ship-metric query) can't drift out of sync.
export const WORKSPACE_KNOWLEDGE_REFERENCED = 'workspace_knowledge_referenced'

interface WorkspaceKnowledgeReferencedProps {
	workspaceId: string
	// Caller reading the knowledge object.
	actorId: string
	// The knowledge object being read.
	entityId: string
	// The bet / insight / task the caller is acting on, if any.
	consumerContextId: string | null
	// `topic:` tags that matched to surface the knowledge object.
	sourceTopics: readonly string[]
}

// Emits the ship-metric event end-to-end: an `events` row (audit log + the
// PG NOTIFY → SSE feed T6 will read for the doc-header chip) plus a PostHog
// capture (the bet's success query). Both paths are fire-and-forget — a
// failed audit or PostHog call must never surface to the caller, so a
// `consult-knowledge` read can never fail on analytics.
export async function trackWorkspaceKnowledgeReferenced(
	db: Database,
	p: WorkspaceKnowledgeReferencedProps,
): Promise<void> {
	try {
		await db.insert(events).values({
			workspaceId: p.workspaceId,
			actorId: p.actorId,
			action: WORKSPACE_KNOWLEDGE_REFERENCED,
			entityType: 'object',
			entityId: p.entityId,
			data: {
				consumer_context_id: p.consumerContextId,
				source_topics: [...p.sourceTopics],
			},
		})
	} catch (err) {
		logger.warn('workspace_knowledge_referenced DB insert failed', {
			actorId: p.actorId,
			entityId: p.entityId,
			error: String(err),
		})
	}

	// PostHog `properties` values are scalar-only (see `PosthogEventProps`),
	// so topics ship as a comma-joined string plus a count for numeric
	// aggregation in the ship-metric query.
	await capturePosthogEvent(WORKSPACE_KNOWLEDGE_REFERENCED, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		entity_id: p.entityId,
		consumer_context_id: p.consumerContextId,
		source_topic_count: p.sourceTopics.length,
		source_topics: p.sourceTopics.join(','),
	})
}
